from fastapi import APIRouter, Depends, HTTPException, status
from core.logging import get_logger, set_context
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.session import AuthUser, require_csrf_protection
from core.database import get_db
from schemas import ScheduledTaskCreate, ScheduledTaskOut, ScheduledTaskUpdate
from utils import validate_userId
from utils.scheduled_tasks import (
    build_scheduled_task_out,
    create_scheduled_task,
    delete_scheduled_task,
    get_scheduled_task,
    hydrate_live_status,
    list_scheduled_tasks_for_user,
    update_scheduled_task,
)


router = APIRouter()
logger = get_logger(__name__)


@router.get(
    "/{user_id}",
    response_model=list[ScheduledTaskOut],
    status_code=status.HTTP_200_OK,
    summary="List the user's scheduled tasks with live run status",
)
async def listScheduledTasks(
    user_id: str,
    current_user: AuthUser = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
) -> list[ScheduledTaskOut]:
    """Return every scheduled task the user owns. ``liveStatus`` is derived from
    each task's latest fire message, so a running fire shows up immediately."""
    set_context(user_id=user_id)
    tasks = await list_scheduled_tasks_for_user(db, current_user.id)
    live = await hydrate_live_status(db, tasks)
    return [build_scheduled_task_out(task, live.get(task.id)) for task in tasks]


@router.post(
    "/{user_id}",
    response_model=ScheduledTaskOut,
    status_code=status.HTTP_201_CREATED,
    summary="Create a scheduled task",
)
async def createScheduledTask(
    user_id: str,
    payload: ScheduledTaskCreate,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
) -> ScheduledTaskOut:
    set_context(user_id=user_id)
    task = await create_scheduled_task(db, current_user, payload)
    logger.info(
        "scheduled_task_created",
        "Scheduled task created",
        task_id=task.id,
        schedule_kind=task.schedule_kind,
        target_mode=task.target_mode,
    )
    return build_scheduled_task_out(task)


@router.patch(
    "/{user_id}/{task_id}",
    response_model=ScheduledTaskOut,
    status_code=status.HTTP_200_OK,
    summary="Update a scheduled task (pause/resume, edit label/prompt/tools)",
)
async def updateScheduledTask(
    user_id: str,
    task_id: str,
    payload: ScheduledTaskUpdate,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
) -> ScheduledTaskOut:
    set_context(user_id=user_id)
    task = await get_scheduled_task(db, current_user.id, task_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Scheduled task not found.")
    task = await update_scheduled_task(db, task, payload)
    live = await hydrate_live_status(db, [task])
    logger.info("scheduled_task_updated", "Scheduled task updated", task_id=task.id, status=task.status)
    return build_scheduled_task_out(task, live.get(task.id))


@router.delete(
    "/{user_id}/{task_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a scheduled task",
)
async def deleteScheduledTask(
    user_id: str,
    task_id: str,
    current_user: AuthUser = Depends(validate_userId),
    _: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
):
    set_context(user_id=user_id)
    task = await get_scheduled_task(db, current_user.id, task_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Scheduled task not found.")
    await delete_scheduled_task(db, task)
    logger.info("scheduled_task_deleted", "Scheduled task deleted", task_id=task_id)
    return
