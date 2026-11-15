"""Pydantic models for plugin-written photo annotations (``photo_annotations``)."""

from typing import Any

from pydantic import BaseModel


class PhotoAnnotation(BaseModel):
    """One source's overlay for a photo. ``payload`` is the stored v1 JSON object
    (see ``db.annotations``); the viewer draws and filters it client-side."""

    source: str
    payload: dict[str, Any]


class PhotoAnnotationsResponse(BaseModel):
    annotations: list[PhotoAnnotation]


class PhotoAnnotationDelete(BaseModel):
    success: bool
    removed: bool


class PhotoAnnotationPut(BaseModel):
    """One source's overlay for one photo, replacing any earlier row of that source."""

    path: str
    source: str
    payload: dict[str, Any]


class PhotoAnnotationSaved(BaseModel):
    success: bool
