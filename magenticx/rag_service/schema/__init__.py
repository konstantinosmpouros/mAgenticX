"""Request/response schemas for the rag_service.

One module per domain (currently just ``retrieval``). Re-exported so callers
keep the stable ``from schema import ...`` import surface, mirroring the
package layout of the other services.
"""
from schema.retrieval import ExcelSQLQuery, Query

__all__ = ["ExcelSQLQuery", "Query"]
