"""Attachment DTOs: upload input, blob/attachment output, image gallery rows, DOCX preview token."""
import base64
from typing import Optional
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from core.settings import settings
from schema.base import UTCDateTime


class BlobOut(BaseModel):
    """Schema to expose a Blob"""
    model_config = ConfigDict(from_attributes=True)
    data: bytes  # Pydantic v2 will base64 this if ever serialized, but we won't expose it directly.


class AttachmentOut(BaseModel):
    """Schema to expose all the info for an Attachment"""
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: str
    name: str = Field(..., validation_alias="file_name")
    mime: str = Field(..., validation_alias="mime_type")
    size: Optional[int] = Field(None, validation_alias="size_bytes")
    timestamp: UTCDateTime = Field(..., validation_alias="created_at")
    # Provenance + agent-supplied display metadata. "upload" (default) for
    # user-attached files, "generated" for a present_artifact deliverable;
    # title/summary are populated for generated artifacts only.
    origin: str = Field("upload", validation_alias="origin")
    title: Optional[str] = Field(None, validation_alias="title")
    summary: Optional[str] = Field(None, validation_alias="summary")

    # keep ORM relation for computation but don't serialize it
    blob: Optional[BlobOut] = Field(None, validation_alias="blob", exclude=True)
    blobId: Optional[str] = Field(None, validation_alias="blob_id")

    # Only for the raw base64 data (image)
    data: Optional[str] = None

    @model_validator(mode="after")
    def _inject_image_b64(self):
        if self.mime and self.mime.startswith("image/") and self.blob and self.blob.data:
            self.data = base64.b64encode(self.blob.data).decode("ascii")
            self.blob = None
        return self


class AttachmentIn(BaseModel):
    """
    For uploads: we accept base64 payloads.
    Only images will ever be sent back base64-encoded by the API.
    """
    name: str
    mime: str
    dataB64: str
    size: Optional[int] = None  # if missing, will be computed from decoded bytes

    @field_validator("name", "mime", "dataB64", mode="before")
    @classmethod
    def _strip_attachment_fields(cls, value):
        if isinstance(value, str):
            return value.strip()
        return value

    @model_validator(mode="after")
    def _validate_attachment(self):
        # Basic presence checks
        if not self.name:
            raise ValueError("Attachment name is required.")
        if not self.mime:
            raise ValueError(f"Attachment '{self.name}' is missing a MIME type.")
        if not self.dataB64:
            raise ValueError(f"Attachment '{self.name}' is missing data.")

        # Validate base64 and decode to get raw bytes for size validation and potential re-encoding (for images).
        try:
            raw = base64.b64decode(self.dataB64, validate=True)
        except Exception as exc:
            raise ValueError(f"Attachment '{self.name}' is not valid base64.") from exc

        # Validate size constraints
        raw_size = len(raw)
        if raw_size <= 0:
            raise ValueError(f"Attachment '{self.name}' is empty.")
        if raw_size > settings.attachments.max_size_bytes:
            raise ValueError(f"Attachment '{self.name}' exceeds the {settings.attachments.max_size_bytes // (1024 * 1024)} MB limit.")
        if self.size is not None and self.size != raw_size:
            raise ValueError(f"Attachment '{self.name}' size metadata does not match payload size.")

        self.size = raw_size
        return self


class DocxPreviewTokenOut(BaseModel):
    token: str
    expiresIn: int


class ImageOut(BaseModel):
    """Schema to expose all the info for an Image"""
    blobId: str = Field(..., validation_alias="blob_id")
    attachmentId: str = Field(..., validation_alias="attachment_id")
    fileName: str = Field(..., validation_alias="file_name")
    mime: str = Field(..., validation_alias="mime_type")
    createdAt: UTCDateTime = Field(..., validation_alias="created_at")
    dataB64: str
