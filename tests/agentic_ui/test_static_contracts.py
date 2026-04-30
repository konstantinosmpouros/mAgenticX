from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
UI_ROOT = ROOT / "src" / "agentic_ui"


def test_frontend_package_exposes_build_and_lint_scripts():
    package = json.loads((UI_ROOT / "package.json").read_text(encoding="utf-8"))

    assert package["scripts"]["build"] == "vite build"
    assert package["scripts"]["lint"] == "eslint ."
    assert "react" in package["dependencies"]
    assert "typescript" in package["devDependencies"]


def test_frontend_api_uses_bridge_v1_route_prefixes():
    api_source = (UI_ROOT / "src" / "lib" / "api.ts").read_text(encoding="utf-8")

    expected_prefixes = [
        'const API_BASE_PATH = "/api/v1";',
        'const AUTH_BASE_PATH = `${API_BASE_PATH}/auth`;',
        'const CATALOG_BASE_PATH = `${API_BASE_PATH}/catalog`;',
        'const PREFERENCES_BASE_PATH = `${API_BASE_PATH}/preferences`;',
        'const CONVERSATIONS_BASE_PATH = `${API_BASE_PATH}/conversations`;',
        'const MESSAGES_BASE_PATH = `${API_BASE_PATH}/messages`;',
        'const ATTACHMENTS_BASE_PATH = `${API_BASE_PATH}/attachments`;',
        'const INFERENCE_BASE_PATH = `${API_BASE_PATH}/inference`;',
        'const SPEECH_BASE_PATH = `${API_BASE_PATH}/speech`;',
        'const SHARED_CONVERSATIONS_BASE_PATH = `${API_BASE_PATH}/shared-conversations`;',
    ]

    for prefix in expected_prefixes:
        assert prefix in api_source


def test_frontend_api_sends_csrf_for_mutating_requests():
    api_source = (UI_ROOT / "src" / "lib" / "api.ts").read_text(encoding="utf-8")

    mutating_functions = [
        "refreshSession",
        "logoutSession",
        "updateUserPreferences",
        "deleteConversation",
        "archiveConversation",
        "unarchiveConversation",
        "reportConversation",
        "renameConversation",
        "createConversation",
        "forkConversation",
        "shareConversation",
        "revokeSharedConversationLink",
        "continueSharedConversation",
        "addMessageToConversation",
        "updateMessageInConversation",
        "likeMessage",
        "dislikeMessage",
        "generateMessageReadAloudAudio",
        "transcribeDictation",
        "streamInference",
    ]

    for function_name in mutating_functions:
        start = api_source.index(f"export async function {function_name}")
        next_function = api_source.find("\nexport ", start + 1)
        block = api_source[start:] if next_function == -1 else api_source[start:next_function]
        assert "{ csrf: true }" in block, function_name


def test_frontend_transformers_handle_backend_aliases_for_shared_features():
    consts_source = (UI_ROOT / "src" / "lib" / "consts.ts").read_text(encoding="utf-8")
    types_source = (UI_ROOT / "src" / "lib" / "types.ts").read_text(encoding="utf-8")

    for field in ["forkedParentId", "forkedMessageId", "isArchived", "archivedAt", "isReported", "reportedAt"]:
        assert field in consts_source
        assert field in types_source

    assert "transformSharedConversationDetail" in consts_source
    assert "ConversationShareResponse" in types_source
    assert "ConversationShareListItem" in types_source
