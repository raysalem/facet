"""Wire models for ``/api/addons`` (the Add-ons page). Never carries an add-on's argv."""

from typing import Literal

from pydantic import BaseModel


class AddonItem(BaseModel):
    id: str
    name: str
    version: str
    icon: str
    facet_api: int
    slots: list[str]
    permissions: list[str]
    mode: Literal["supervised", "external"]
    ui_path: str
    # external | stopped (supervised add-ons get live states with the supervisor)
    status: str
    live_tokens: int = 0


class RefusedManifest(BaseModel):
    directory: str
    reason: str


class AddonList(BaseModel):
    addons: list[AddonItem]
    refused: list[RefusedManifest]
    addons_dir: str


class AddonTokenCreated(BaseModel):
    """The one response that carries an external add-on's token in plaintext."""

    id: int
    addon_id: str
    level: str
    token: str
    scopes: list[str]


class AddonTokensRevoked(BaseModel):
    addon_id: str
    revoked: int

