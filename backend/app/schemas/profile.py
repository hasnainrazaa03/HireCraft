"""Career profile and writing profile API schemas."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, HttpUrl, model_validator

WorkArrangement = Literal["remote", "hybrid", "onsite", "flexible"]
SalaryPeriod = Literal["hourly", "weekly", "monthly", "yearly"]


class ProfileModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, str_strip_whitespace=True)


class CareerProfileUpdate(ProfileModel):
    """All fields optional — the client sends only what changed."""

    headline: str | None = Field(default=None, max_length=200)
    phone: str | None = Field(default=None, max_length=40)
    location: str | None = Field(default=None, max_length=180)
    country: str | None = Field(default=None, max_length=80)

    # An application is an employment record, so it asks for the name on the
    # candidate's documents — which is not always the name they go by.
    legal_first_name: str | None = Field(default=None, max_length=120)
    legal_last_name: str | None = Field(default=None, max_length=120)
    preferred_name: str | None = Field(default=None, max_length=120)
    # Where an employer should write, which need not be the login address.
    contact_email: EmailStr | None = None

    linkedin_url: HttpUrl | None = None
    github_url: HttpUrl | None = None
    portfolio_url: HttpUrl | None = None
    website_url: HttpUrl | None = None

    work_authorization: str | None = Field(default=None, max_length=120)
    visa_status: str | None = Field(default=None, max_length=120)
    # The yes/no pair nearly every US application asks. Kept independent:
    # someone on F-1 OPT is authorized to work now *and* needs sponsorship
    # later, so neither answer follows from the other.
    authorized_to_work: bool | None = None
    requires_sponsorship: bool | None = None
    years_experience: float | None = Field(default=None, ge=0, le=60)

    preferred_roles: list[str] | None = Field(default=None, max_length=20)
    preferred_industries: list[str] | None = Field(default=None, max_length=20)
    preferred_locations: list[str] | None = Field(default=None, max_length=20)

    salary_min: int | None = Field(default=None, ge=0, le=10_000_000)
    salary_max: int | None = Field(default=None, ge=0, le=10_000_000)
    salary_currency: str | None = Field(default=None, min_length=3, max_length=3)
    salary_period: SalaryPeriod | None = None

    work_arrangement: WorkArrangement | None = None
    open_to_relocation: bool | None = None

    @model_validator(mode="after")
    def _check_salary_range(self) -> CareerProfileUpdate:
        if (
            self.salary_min is not None
            and self.salary_max is not None
            and self.salary_max < self.salary_min
        ):
            raise ValueError("Maximum salary cannot be less than minimum salary")
        return self


class CareerProfileResponse(ProfileModel):
    headline: str | None
    phone: str | None
    location: str | None
    country: str | None
    legal_first_name: str | None
    legal_last_name: str | None
    preferred_name: str | None
    contact_email: str | None
    linkedin_url: str | None
    github_url: str | None
    portfolio_url: str | None
    website_url: str | None
    work_authorization: str | None
    visa_status: str | None
    authorized_to_work: bool | None
    requires_sponsorship: bool | None
    years_experience: float | None
    preferred_roles: list[str]
    preferred_industries: list[str]
    preferred_locations: list[str]
    salary_min: int | None
    salary_max: int | None
    salary_currency: str
    salary_period: str | None
    work_arrangement: str | None
    open_to_relocation: bool


# --- Bring-your-own API key -------------------------------------------------


class ApiKeyStatus(ProfileModel):
    configured: bool
    hint: str | None = None  # e.g. "…aB3d" — last 4 chars, never the whole key


class ApiKeyUpdate(ProfileModel):
    api_key: Annotated[str, Field(min_length=10, max_length=200)]
