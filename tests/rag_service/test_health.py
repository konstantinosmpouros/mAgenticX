from __future__ import annotations


def test_config_loads_sample_workbook_into_duckdb(rag_service):
    assert rag_service.config.TABLES
    assert "financial_sample" in rag_service.config.TABLES
    assert rag_service.config.TABLES["financial_sample"]["schema"]["region"] == "object"
