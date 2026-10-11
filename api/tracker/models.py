"""Validated command payloads for the PostgreSQL OneShot API."""

from typing import Literal

from pydantic import BaseModel, Field, model_validator


ApplicationStage = Literal[
    "applied",
    "replied",
    "assessment",
    "interview",
    "offer",
    "closed",
]
ClosedReason = Literal["rejected", "withdrawn", "no_reply"]


class ApplicationSubmit(BaseModel):
    submitted_at: str | None = Field(default=None, max_length=80)


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
    task_state: Literal["action", "waiting"] | None = None
    waiting_for: str | None = Field(default=None, max_length=500)
    activity: str | None = Field(default=None, max_length=4500)

    @model_validator(mode="after")
    def mutation_requires_a_field(self) -> "ApplicationUpdate":
        if not self.model_fields_set:
            raise ValueError("at least one application field is required")
        if self.stage == "closed" and self.closed_reason is None:
            raise ValueError("closed_reason is required when stage is closed")
        if self.stage is not None and self.stage != "closed" and self.closed_reason is not None:
            raise ValueError("closed_reason is only valid when stage is closed")
        if "stage" in self.model_fields_set and self.stage is None:
            raise ValueError("stage cannot be null")
        if "task_state" in self.model_fields_set and self.task_state is None:
            raise ValueError("task_state cannot be null")
        return self


class ExternalApplicationCreate(BaseModel):
    company: str = Field(min_length=1, max_length=500)
    title: str = Field(min_length=1, max_length=1000)
    url: str = Field(default="", max_length=4000)
    location: str = Field(default="", max_length=1000)
    note: str = Field(default="", max_length=8000)
    submitted_at: str | None = Field(default=None, max_length=80)


FeedbackKind = Literal["skip", "mislabeled"]
SkipReason = Literal["level", "location", "field", "company"]
CorrectionField = Literal["type", "focus", "company", "location", "skills"]


class FeedbackCorrection(BaseModel):
    """One disputed label: what the posting says, and optionally what it should."""

    model_config = {"populate_by_name": True}

    field: CorrectionField
    # ``from`` is a Python keyword, so the attribute carries a suffix while the
    # wire name stays the natural one.
    from_: str = Field(alias="from", max_length=300)
    to: str | None = Field(default=None, max_length=300)


class JobFeedbackCommand(BaseModel):
    kind: FeedbackKind
    skip_reason: SkipReason | None = None
    corrections: list[FeedbackCorrection] = Field(default_factory=list, max_length=5)

    @model_validator(mode="after")
    def reason_matches_kind(self) -> "JobFeedbackCommand":
        if self.kind == "skip" and self.corrections:
            raise ValueError("a skip carries no corrections")
        if self.kind == "mislabeled":
            if self.skip_reason is not None:
                raise ValueError("skip_reason is only valid for a skip")
            if not self.corrections:
                raise ValueError("a mislabeled report needs at least one correction")
        return self
