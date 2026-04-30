from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MCP_ROOT = ROOT / "src" / "mcp_gateway"


def test_mcp_gateway_compose_references_required_config_files():
    compose = (ROOT / "src" / "docker-compose-mcp.yaml").read_text(encoding="utf-8")

    assert "--transport=sse" in compose
    assert "--port=8005" in compose
    assert "--catalog=./app/mcp_catalog.yaml" in compose
    assert "--config=./app/mcp_config.yaml" in compose
    assert "--secrets=/app/secrets/mcp_secret.env" in compose
    assert "./mcp_gateway/mcp_catalog.yaml:/app/mcp_catalog.yaml" in compose
    assert "./mcp_gateway/mcp_config.yaml:/app/mcp_config.yaml" in compose
    assert "./mcp_gateway/mcp_secret.env:/app/secrets/mcp_secret.env" in compose


def test_mcp_gateway_active_servers_are_documented_in_local_files():
    compose = (ROOT / "src" / "docker-compose-mcp.yaml").read_text(encoding="utf-8")
    catalog = (MCP_ROOT / "mcp_catalog.yaml").read_text(encoding="utf-8")
    config = (MCP_ROOT / "mcp_config.yaml").read_text(encoding="utf-8")
    example_secret = (MCP_ROOT / "mcp_sercret.example.env").read_text(encoding="utf-8")

    assert "--servers=tavily,arxiv-mcp-server" in compose
    assert "tavily:" in catalog
    assert "arxiv-mcp-server:" in catalog
    assert "arxiv-mcp-server:" in config
    assert "storage_path:" in config
    assert "tavily.api_token=" in example_secret
