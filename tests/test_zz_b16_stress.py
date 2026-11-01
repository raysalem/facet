"""B16 stress (fork-only): the failing pattern of tests/test_jpegxl.py, repeated.

seed_photos_prefix opens its connection first, then an app starts on the same shared DB
(as jxl_client does), then the seed INSERT runs while the app's startup threads work.
B16_ITER sets the repetitions; each one is a separate test so the probe sees it.
"""
import os

import pytest
from fastapi.testclient import TestClient

from api import create_app
from api.auth import CurrentUser, get_optional_user

ITERATIONS = int(os.environ.get("B16_ITER", "20"))


@pytest.mark.parametrize("i", range(ITERATIONS))
def test_seed_while_app_starts(i, tmp_path, seed_photos_prefix):
    app = create_app()
    app.dependency_overrides[get_optional_user] = lambda: CurrentUser(user_id=None, role="admin")
    with TestClient(app):
        path = tmp_path / "stress.jxl"
        seed_photos_prefix(str(tmp_path) + os.sep, [{"path": str(path), "filename": path.name}])
    app.dependency_overrides.clear()
