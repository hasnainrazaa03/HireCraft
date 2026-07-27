"""Tests for the Gemini schema sanitizer.

These lock in the fix for a live 400 INVALID_ARGUMENT: Gemini's structured
output rejects the $ref / anyOf / default keywords Pydantic emits, so every
tailoring run failed on its first LLM call. The sanitizer must strip exactly
those keywords while preserving the structure Gemini needs to steer output.
"""

from __future__ import annotations

from app.schemas.job import JobRequirements
from app.schemas.resume import Experience, MasterResume
from app.schemas.tailoring import TailoringResult
from app.services.llm.schema import to_gemini_schema

# Keywords Gemini's schema dialect rejects. None may survive as a schema-level
# mapping key (property *names* are exempt - a field may legitimately be called
# "title" or "default").
FORBIDDEN = {
    "$ref",
    "$defs",
    "anyOf",
    "oneOf",
    "default",
    "title",
    "maxLength",
    "minLength",
    "maxItems",
    "minItems",
    "additionalProperties",
    "exclusiveMinimum",
    "exclusiveMaximum",
}


def _schema_level_keys(node: object, acc: set[str]) -> set[str]:
    """Collect mapping keys, skipping into ``properties`` values but not treating
    the property names themselves as schema keywords."""
    if isinstance(node, dict):
        for key, value in node.items():
            acc.add(key)
            if key == "properties" and isinstance(value, dict):
                for prop_schema in value.values():
                    _schema_level_keys(prop_schema, acc)
            else:
                _schema_level_keys(value, acc)
    elif isinstance(node, list):
        for item in node:
            _schema_level_keys(item, acc)
    return acc


class TestToGeminiSchema:
    def test_job_requirements_has_no_forbidden_keywords(self):
        schema = to_gemini_schema(JobRequirements)
        assert not (FORBIDDEN & _schema_level_keys(schema, set()))

    def test_tailoring_result_has_no_forbidden_keywords(self):
        schema = to_gemini_schema(TailoringResult)
        assert not (FORBIDDEN & _schema_level_keys(schema, set()))

    def test_root_is_a_typed_object(self):
        schema = to_gemini_schema(JobRequirements)
        assert schema["type"] == "object"
        assert "properties" in schema

    def test_optional_field_becomes_nullable(self):
        """str | None must collapse from anyOf to a nullable typed field."""
        title = to_gemini_schema(JobRequirements)["properties"]["title"]
        assert title["type"] == "string"
        assert title["nullable"] is True

    def test_nested_model_list_is_preserved(self):
        """required_skills: list[Skill] must stay an array of typed objects."""
        skills = to_gemini_schema(JobRequirements)["properties"]["required_skills"]
        assert skills["type"] == "array"
        assert skills["items"]["type"] == "object"
        assert "importance" in skills["items"]["properties"]

    def test_property_named_like_a_keyword_survives(self):
        """A field literally called 'title' must not be stripped as metadata."""
        assert "title" in to_gemini_schema(JobRequirements)["properties"]

    def test_enum_values_survive(self):
        """Literal fields carry their allowed values through as an enum."""
        seniority = to_gemini_schema(JobRequirements)["properties"]["seniority"]
        assert "enum" in seniority
        assert "intern" in seniority["enum"]

    def test_required_fields_are_ordered_before_optional(self):
        """Generation order is pinned required-first.

        Gemini emits properties in schema order, and a nullable field generated
        before the fields that identify its object comes back null. Experience
        inherits start_date/end_date from a base class that declares them first,
        so without reordering an entry's dates were emitted before its
        company/title and every résumé import lost them. The required, non-null
        company and title must now precede the optional dates.
        """
        exp = to_gemini_schema(Experience)
        order = exp["propertyOrdering"]
        assert order[: len(exp["required"])] == [k for k in order if k in set(exp["required"])]
        assert order.index("company") < order.index("start_date")
        assert order.index("title") < order.index("start_date")
        # propertyOrdering must list every property exactly once.
        assert sorted(order) == sorted(exp["properties"].keys())

    def test_ordering_is_recursive_into_nested_objects(self):
        """Nested entry objects inside the résumé get the same ordering."""
        schema = to_gemini_schema(MasterResume)
        item = schema["properties"]["experience"]["items"]
        assert item["propertyOrdering"].index("company") < item[
            "propertyOrdering"
        ].index("start_date")
