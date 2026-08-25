"""Recognising a model or SDK that refuses the temperature parameter.

Claude Sonnet 5 does not accept it. There are two ways that surfaces, and only
one was originally handled: the API can reject the request, or a newer SDK can
drop the parameter from the method signature so Python raises a TypeError before
any request is made. The second form went unrecognised, the retry never fired,
and every structured call failed — which meant résumé import did not work at all.
"""

from __future__ import annotations

import pytest

from app.services.llm.providers import _temperature_rejected


@pytest.mark.parametrize(
    "message",
    [
        # The SDK signature no longer has it — raised before any HTTP call.
        "Messages.create() got an unexpected keyword argument 'temperature'",
        "create() got an unexpected keyword argument 'temperature'",
        # The API rejects it in a response.
        "temperature is deprecated for this model",
        "The parameter 'temperature' is unsupported for claude-sonnet-5",
        "This model does not support temperature",
    ],
)
def test_a_refusal_is_recognised(message: str) -> None:
    assert _temperature_rejected(Exception(message))


@pytest.mark.parametrize(
    "message",
    [
        "Connection reset by peer",
        "rate limit exceeded",
        "invalid api key",
        "max_tokens is required",
        # Mentions temperature but is not a refusal of the parameter — retrying
        # without it would silently hide a real error.
        "temperature must be between 0 and 1",
        "Messages.create() got an unexpected keyword argument 'top_k'",
    ],
)
def test_other_failures_are_not_mistaken_for_one(message: str) -> None:
    assert not _temperature_rejected(Exception(message))
