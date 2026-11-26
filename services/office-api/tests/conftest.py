from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from office_api import main


@pytest.fixture()
def client() -> TestClient:
    return TestClient(main.app)
