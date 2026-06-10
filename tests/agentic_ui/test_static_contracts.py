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
        'const VOICE_BASE_PATH = `${API_BASE_PATH}/voice`;',
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
        "addMessageToConversation",
        "updateMessageInConversation",
        "likeMessage",
        "dislikeMessage",
        "generateMessageReadAloudAudio",
        "transcribeDictation",
        "createRealtimeVoiceSession",
        "persistRealtimeVoiceConversationEvent",
        "endRealtimeVoiceSession",
        "startInference",
        "cancelInferenceRun",
    ]

    for function_name in mutating_functions:
        start = api_source.index(f"export async function {function_name}")
        next_function = api_source.find("\nexport ", start + 1)
        block = api_source[start:] if next_function == -1 else api_source[start:next_function]
        assert "{ csrf: true }" in block, function_name


def test_inference_runtime_starts_normal_flows_through_backend_start_api():
    runtime_source = (UI_ROOT / "src" / "runtime" / "inference.ts").read_text(encoding="utf-8")
    hook_source = (UI_ROOT / "src" / "hooks" / "useInferenceRuns.ts").read_text(encoding="utf-8")
    api_source = (UI_ROOT / "src" / "lib" / "api.ts").read_text(encoding="utf-8")

    assert "createConversation" not in runtime_source
    assert "addMessageToConversation" not in runtime_source
    assert 'mode: "new"' in runtime_source
    assert 'mode: "shared_continue"' in runtime_source
    assert "continueSharedConversation" not in api_source
    assert 'mode: "send"' in runtime_source
    assert "mode: 'edit'" in runtime_source
    assert "mode: 'retry'" in runtime_source
    assert "startInference(userId, request)" in hook_source
    assert "/runs/${userId}/start" in api_source
    assert "startInferenceRun" not in api_source


def test_attachment_preview_registry_covers_requested_formats():
    registry_source = (
        UI_ROOT / "src" / "components" / "chat" / "attachment_preview_parts" / "registry.ts"
    ).read_text(encoding="utf-8")
    api_source = (UI_ROOT / "src" / "lib" / "api.ts").read_text(encoding="utf-8")

    for expected in [
        '"pdf"',
        '"docx"',
        '"xlsx"',
        '"pptx"',
        '"markdown"',
        '"json"',
        '"csv"',
        '"code"',
        '"text"',
        '"unsupported"',
        '["doc", "xls"]',
    ]:
        assert expected in registry_source

    assert "fetchAttachmentPreviewBlob" in api_source
    assert "getAttachmentPreviewUrl" in api_source


def test_excel_preview_uses_office_online_viewer_not_exceljs():
    registry_source = (
        UI_ROOT / "src" / "components" / "chat" / "attachment_preview_parts" / "registry.ts"
    ).read_text(encoding="utf-8")
    panel_source = (
        UI_ROOT / "src" / "components" / "chat" / "AttachmentPreviewPanel.tsx"
    ).read_text(encoding="utf-8")

    xlsx_block_start = registry_source.index('kind: "xlsx"')
    xlsx_block_end = registry_source.index("};", xlsx_block_start)
    xlsx_block = registry_source[xlsx_block_start:xlsx_block_end]

    assert "requiresBlob: false" in xlsx_block
    assert "usesDerivedPdf" not in xlsx_block
    assert "fetchDocxPreviewToken" in panel_source
    assert "view.officeapps.live.com" in panel_source
    assert 'descriptor.kind === "xlsx"' in panel_source
    assert "ExcelPreview" not in panel_source


def test_word_and_excel_share_office_online_viewer_path():
    panel_source = (
        UI_ROOT / "src" / "components" / "chat" / "AttachmentPreviewPanel.tsx"
    ).read_text(encoding="utf-8")

    assert '"docx" || descriptor.kind === "xlsx"' in panel_source
    assert "<DocxPreview" in panel_source
    assert "fetchDocxPreviewToken" in panel_source


def test_frontend_upload_utils_infer_missing_browser_mime_types():
    utils_source = (UI_ROOT / "src" / "lib" / "utils.ts").read_text(encoding="utf-8")

    assert "resolveUploadMimeType" in utils_source
    assert 'md: "text/markdown"' in utils_source
    assert 'docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"' in utils_source
    assert 'xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"' in utils_source
    assert 'pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"' in utils_source
    assert 'return "application/octet-stream";' in utils_source


def test_frontend_transformers_handle_backend_aliases_for_shared_features():
    consts_source = (UI_ROOT / "src" / "lib" / "consts.ts").read_text(encoding="utf-8")
    types_source = (UI_ROOT / "src" / "lib" / "types.ts").read_text(encoding="utf-8")

    for field in ["forkedParentId", "forkedMessageId", "isArchived", "archivedAt", "isReported", "reportedAt"]:
        assert field in consts_source
        assert field in types_source

    assert "transformSharedConversationDetail" in consts_source
    assert "ConversationShareResponse" in types_source
    assert "ConversationShareListItem" in types_source


def test_frontend_carries_per_message_agent_attribution():
    consts_source = (UI_ROOT / "src" / "lib" / "consts.ts").read_text(encoding="utf-8")
    types_source = (UI_ROOT / "src" / "lib" / "types.ts").read_text(encoding="utf-8")
    inference_source = (UI_ROOT / "src" / "runtime" / "inference.ts").read_text(encoding="utf-8")

    # MessageOut type + transformer carry the per-message agent (both casings).
    for field in ["agentId", "agentName"]:
        assert field in types_source
        assert field in consts_source
    assert "agent_id" in consts_source
    assert "agent_name" in consts_source

    # "send" mode now forwards the currently-selected agent for the next turn.
    assert "agentId: currentAgent?.id" in inference_source
