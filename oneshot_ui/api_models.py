"""Validated command payloads for the PostgreSQL OneShot API."""

from typing import Literal

from pydantic import BaseModel, Field, model_validator


ApplicationStage = Literal[
    "considering",
    "applied",
    "assessment",
    "interview",
    "offer",
    "closed",
]
ClosedReason = Literal["rejected", "withdrawn", "no_reply"]


class ApplicationUpdate(BaseModel):
    stage: ApplicationStage | None = None
    closed_reason: ClosedReason | None = None
    company: str | None = Field(default=None, min_length=1, max_length=500)
    title: str | None = Field(default=None, min_length=1, max_length=1000)
    location: str | None = Field(default=None, max_length=1000)
    apply_url_snapshot: str | None = Field(default=None, max_length=4000)
    resume_variant: str | None = Field(default=None, max_length=200)
    submitted_at: str | None = Field(default=None, max_length=80)
    next_action: str | None = Field(default=None, max_length=4000)
    next_due_at: str | None = Field(default=None, max_length=80)
    note: str | None = Field(default=None, max_length=8000)

    @model_validator(mode="after")
    def mutation_requires_a_field(self) -> "ApplicationUpdate":
        if not self.model_fields_set:
            raise ValueError("at least one application field is required")
        if self.stage == "closed" and self.closed_reason is None:
            raise ValueError("closed_reason is required when stage is closed")
        if self.stage is not None and self.stage != "closed" and self.closed_reason is not None:
            raise ValueError("closed_reason is only valid when stage is closed")
        return self


class ExternalApplicationCreate(BaseModel):
    company: str = Field(min_length=1, max_length=500)
    title: str = Field(min_length=1, max_length=1000)
    url: str = Field(min_length=1, max_length=4000)
    location: str = Field(default="", max_length=1000)
    note: str = Field(default="", max_length=4000)
