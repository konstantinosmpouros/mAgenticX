from __future__ import annotations


def test_config_loads_sample_workbook_into_duckdb(rag_service):
    from core.duck_db import TABLES
    assert TABLES
    assert "financial_sample" in TABLES
    assert TABLES["financial_sample"]["schema"]["region"] == "object"
