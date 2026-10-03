from __future__ import annotations

from langchain_core.documents import Document


class _FakeRetriever:
    def __init__(self, docs):
        self._docs = docs

    async def ainvoke(self, query):
        return self._docs


class _FakeChroma:
    def __init__(self, *args, **kwargs):
        pass

    def as_retriever(self, search_kwargs):
        assert search_kwargs == {"k": 2}
        return _FakeRetriever(
            [
                Document(page_content="First result", metadata={"source": "doc-1"}),
                Document(page_content="Second result", metadata={"source": "doc-2"}),
            ]
        )


class _EmptyChroma:
    def __init__(self, *args, **kwargs):
        pass

    def as_retriever(self, search_kwargs):
        return _FakeRetriever([])


class _FailingRetriever:
    async def ainvoke(self, query):
        raise RuntimeError("chroma unavailable")


class _FailingChroma:
    def __init__(self, *args, **kwargs):
        pass

    def as_retriever(self, search_kwargs):
        return _FailingRetriever()


async def test_retrieve_returns_documents(client, rag_service, internal_headers, monkeypatch):
    monkeypatch.setattr(rag_service.main.chromadb, "HttpClient", lambda **kwargs: object())
    monkeypatch.setattr(rag_service.main, "Chroma", _FakeChroma)

    response = await client.post(
        "/retrieve/hr_policies",
        headers=internal_headers,
        json={"query": "benefits", "k": 2},
    )

    assert response.status_code == 200
    assert response.json() == {
        "query": "benefits",
        "k": 2,
        "documents": [
            {"content": "First result", "metadata": {"source": "doc-1"}},
            {"content": "Second result", "metadata": {"source": "doc-2"}},
        ],
    }


async def test_retrieve_returns_404_when_no_documents_found(client, rag_service, internal_headers, monkeypatch):
    monkeypatch.setattr(rag_service.main.chromadb, "HttpClient", lambda **kwargs: object())
    monkeypatch.setattr(rag_service.main, "Chroma", _EmptyChroma)

    response = await client.post(
        "/retrieve/hr_policies",
        headers=internal_headers,
        json={"query": "missing", "k": 2},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "No documents found"


async def test_retrieve_returns_503_when_vector_store_fails(client, rag_service, internal_headers, monkeypatch):
    monkeypatch.setattr(rag_service.main.chromadb, "HttpClient", lambda **kwargs: object())
    monkeypatch.setattr(rag_service.main, "Chroma", _FailingChroma)

    response = await client.post(
        "/retrieve/hr_policies",
        headers=internal_headers,
        json={"query": "benefits", "k": 2},
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "Document retrieval is temporarily unavailable. Please try again."


async def test_an_invalid_body_is_a_422_not_a_500(client, internal_headers):
    """The validation handler used to call `exc.errors(include_input=False)` — a
    pydantic keyword FastAPI's RequestValidationError does not take — so every
    malformed request crashed the handler and surfaced as a 500."""
    response = await client.post(
        "/retrieve/hr_policies",
        headers=internal_headers,
        json={"query": {"not": "a string"}, "k": "many"},
    )

    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid request. Please check the submitted fields and try again."}
