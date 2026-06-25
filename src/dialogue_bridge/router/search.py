from fastapi import APIRouter, Depends, Query, status
from observability import get_logger, set_context
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from core.auth_session import AuthUser
from schemas import WorkspaceSearchResult
from utils import validate_userId
from utils.search import clean_search_query, search_workspace_data


router = APIRouter()
logger = get_logger(__name__)


@router.get(
    "/{user_id}",
    response_model=list[WorkspaceSearchResult],
    status_code=status.HTTP_200_OK,
    summary="Search conversations, messages, files, and agents for the user",
)
async def searchWorkspace(
    user_id: str,
    q: str = Query("", min_length=0, max_length=200),
    limit: int = Query(20, ge=1, le=50),
    current_user: AuthUser = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
):
    query = clean_search_query(q)
    set_context(user_id=user_id)
    if not query:
        return []

    results = await search_workspace_data(
        db=db,
        current_user=current_user,
        query=query,
        limit=limit,
    )
    logger.info("workspace_search_completed", "Workspace search completed", query_length=len(query), result_count=len(results[:limit]))
    return results
