"""Convert a Pydantic model's JSON Schema into one Gemini will accept.

Gemini's structured-output endpoint implements a restricted subset of JSON
Schema. Handing it a Pydantic model directly fails with a bare
``400 INVALID_ARGUMENT`` because Pydantic emits three things Gemini rejects:

* ``$defs`` / ``$ref`` - Gemini has no reference resolution, so every nested
  model must be inlined.
* nullable ``anyOf`` - Pydantic renders ``str | None`` as
  ``{"anyOf": [{"type": "string"}, {"type": "null"}]}``; Gemini expresses the
  same thing as ``{"type": "string", "nullable": true}``.
* annotation keywords - ``default``, ``title``, ``maxLength``, ``minItems`` and
  friends are validation metadata Gemini does not understand.

This is a steering aid, not a correctness guarantee: the client re-validates
every response against the real Pydantic model regardless, so anything this
sanitizer has to drop (a length bound, say) is still enforced on the way back.
"""

from __future__ import annotations

from typing import Any

# Keywords Gemini's schema dialect understands. Everything else is discarded.
_ALLOWED_KEYS = frozenset(
    {"type", "format", "description", "nullable", "enum", "properties", "required",
     "items", "propertyOrdering"}
)

# JSON Schema types Gemini accepts, lowercased.
_ALLOWED_FORMATS = {"date-time", "int32", "int64", "float", "double", "enum"}


def _resolve_ref(ref: str, defs: dict[str, Any]) -> dict[str, Any]:
    # Refs look like "#/$defs/Skill"; only local definition refs are produced.
    name = ref.split("/")[-1]
    if name not in defs:
        raise ValueError(f"Unresolvable schema reference: {ref}")
    return defs[name]


def _convert(node: Any, defs: dict[str, Any]) -> Any:
    if not isinstance(node, dict):
        return node

    if "$ref" in node:
        node = {**_resolve_ref(node["$ref"], defs), **{k: v for k, v in node.items() if k != "$ref"}}

    # Flatten "anyOf"/"oneOf". The only form Pydantic emits here is an optional:
    # exactly one real branch plus a {"type": "null"} branch. Collapse it to the
    # real branch tagged nullable; if there are several real branches Gemini
    # cannot express the union, so fall back to the first and stay nullable.
    for union_key in ("anyOf", "oneOf"):
        if union_key in node:
            branches = node[union_key]
            non_null = [b for b in branches if b.get("type") != "null"]
            was_nullable = len(non_null) != len(branches)
            chosen = non_null[0] if non_null else {"type": "string"}
            merged = {**{k: v for k, v in node.items() if k != union_key}, **chosen}
            result = _convert(merged, defs)
            if was_nullable and isinstance(result, dict):
                result["nullable"] = True
            return result

    out: dict[str, Any] = {}
    for key, value in node.items():
        if key not in _ALLOWED_KEYS:
            continue
        if key == "properties" and isinstance(value, dict):
            out["properties"] = {k: _convert(v, defs) for k, v in value.items()}
        elif key == "items":
            out["items"] = _convert(value, defs)
        elif key == "format":
            out["format"] = value if value in _ALLOWED_FORMATS else None
        else:
            out[key] = value

    if out.get("format") is None:
        out.pop("format", None)

    # Gemini requires an explicit type on every object node. Pydantic omits it
    # when properties are present, so restore it.
    if "properties" in out and "type" not in out:
        out["type"] = "object"

    # Two things happen here, both about how Gemini's structured output treats
    # properties by their position and their presence in `required`.
    #
    # 1. Force every array property into `required`. Gemini treats any field
    #    absent from `required` as optional and will silently omit it — which for
    #    a résumé meant whole sections (the entire `experience` list) vanishing at
    #    random while `education` happened to survive. Arrays are always safe to
    #    require: the worst case the model can produce is an explicit empty list,
    #    never invented content. (Length bounds like min_items are re-checked by
    #    the real Pydantic model on the way back, so this can't smuggle in a bad
    #    list either.)
    #
    # 2. Pin generation order: required fields first, then optional ones. Gemini
    #    emits properties in schema order, and a nullable field generated *before*
    #    the fields that give it meaning tends to come back null — an entry's
    #    start_date, declared on a shared base class ahead of its company/title,
    #    was emitted before the model had "written" which entry it was on, so
    #    dates were lost. Ordering the identifying (required) fields first fixes
    #    that and steers every structured call to describe each object before its
    #    dependent fields.
    if "properties" in out:
        props = out["properties"]
        required = set(out.get("required", []))
        for key, value in props.items():
            if isinstance(value, dict) and value.get("type") == "array":
                required.add(key)
        keys = list(props.keys())
        ordered = [k for k in keys if k in required] + [k for k in keys if k not in required]
        out["properties"] = {k: props[k] for k in ordered}
        if required:
            out["required"] = [k for k in keys if k in required]
        out["propertyOrdering"] = ordered

    return out


def to_gemini_schema(model: type) -> dict[str, Any]:
    """Return a Gemini-compatible response schema for a Pydantic model."""
    json_schema = model.model_json_schema()
    defs = json_schema.get("$defs", {})
    return _convert(json_schema, defs)
