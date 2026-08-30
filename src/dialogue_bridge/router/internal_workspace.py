"""Internal (service-to-service) workspace endpoints — the hydration source.

Not browser-facing: gated by ``require_internal_caller`` (the shared internal
proxy secret) AND blocked at the nginx edge (``/api/v1/internal/``), so only the
agents service reaching the bridge on the ``backend`` network can call them.
Same trust model as ``internal_memory``.

These exist because ``chat_db`` is now the source of truth for user-authored
agents and skills, while the *runtime* still reads them off the agents-service
volume. That volume has no backup, so it needs to be rebuildable: the agents
service asks here for what a user should have, and materialises anything
missing. Without this the content is safe but not restorable — and the agents
service could never run a second replica, because a fresh container would come
up with an empty workspace.
"""
from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import (
    AgentDefinitionFileTable,
    AgentTable,
    UserAgentSkillTable,
    UserSkillFileTable,
    UserSkillPoolTable,
    UserSkillTable,
    get_db,
)
from core.logging import get_logger, set_context
from core.security.internal_trust import require_internal_caller

router = APIRouter()
logger = get_logger(__name__)


@router.get(
    "/workspace/users",
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
    summary="Internal: user ids that have workspace content worth materialising",
)
async def listWorkspaceUsers(db: AsyncSession = Depends(get_db)) -> list[str]:
    """Only users we actually hold something for.

    Keeps the hydrator's work proportional to real content rather than to the
    size of the user table — most users have neither a custom agent nor a
    custom skill, and provisioning empty folders for them would be noise.
    """
    agent_users = (
        await db.execute(
            select(AgentTable.owner_user_id).where(
                AgentTable.owner_user_id.isnot(None), AgentTable.is_active == True  # noqa: E712
            )
        )
    ).scalars().all()
    pool_users = (
        await db.execute(select(UserSkillPoolTable.user_id))
    ).scalars().all()
    return sorted({u for u in (*agent_users, *pool_users) if u})


@router.get(
    "/workspace/users/{user_id}",
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(require_internal_caller)],
    summary="Internal: everything a user's agent workspace should contain",
)
async def getWorkspaceContent(user_id: str, db: AsyncSession = Depends(get_db)) -> dict:
    """The authored content for one user, in the shape the writers upstream take.

    Deliberately *not* a diff: the agents service decides what is missing, since
    only it can see the volume. This endpoint answers "what should be there",
    which keeps the bridge free of any filesystem knowledge.
    """
    set_context(user_id=user_id)

    # --- custom agents ---------------------------------------------------
    agent_rows = (
        await db.execute(
            select(AgentTable).where(
                AgentTable.owner_user_id == user_id,
                AgentTable.is_active == True,  # noqa: E712
            )
        )
    ).scalars().all()

    agents: list[dict] = []
    for row in agent_rows:
        if not row.definition_spec:
            # Pre-dates the store and has not been adopted yet (adoption happens
            # on first read in the builder). Nothing to materialise from here,
            # and the volume copy is still the one serving runs.
            continue
        files = (
            await db.execute(
                select(AgentDefinitionFileTable)
                .where(AgentDefinitionFileTable.agent_id == row.id)
                .order_by(AgentDefinitionFileTable.path)
            )
        ).scalars().all()
        agents.append(
            {
                "slug": row.slug,
                "spec": row.definition_spec,
                "files": [{"path": f.path, "content": f.content} for f in files],
            }
        )

    # --- skills: pool membership, custom content, assignments ------------
    pool = (
        await db.execute(
            select(UserSkillPoolTable).where(UserSkillPoolTable.user_id == user_id)
        )
    ).scalars().all()

    custom_rows = (
        await db.execute(select(UserSkillTable).where(UserSkillTable.user_id == user_id))
    ).scalars().all()
    custom_by_name = {row.name: row for row in custom_rows}

    skills: list[dict] = []
    for entry in pool:
        skill = custom_by_name.get(entry.skill_name)
        if entry.type == "global" or skill is None:
            skills.append({"name": entry.skill_name, "type": "global"})
            continue
        files = (
            await db.execute(
                select(UserSkillFileTable)
                .where(UserSkillFileTable.skill_id == skill.id)
                .order_by(UserSkillFileTable.path)
            )
        ).scalars().all()
        skills.append(
            {
                "name": skill.name,
                "type": "custom",
                "description": skill.description,
                "category": skill.category,
                "origin": skill.origin,
                "createdByAgent": skill.created_by_agent,
                "files": [{"path": f.path, "content": f.content} for f in files],
            }
        )

    assignment_rows = (
        await db.execute(
            select(UserAgentSkillTable).where(UserAgentSkillTable.user_id == user_id)
        )
    ).scalars().all()
    assignments: dict[str, list[str]] = {}
    for row in assignment_rows:
        assignments.setdefault(row.agent_slug, []).append(row.skill_name)

    logger.info(
        "workspace_content_served",
        "Served a user's authored workspace content for hydration",
        agent_count=len(agents),
        skill_count=len(skills),
        assignment_agents=len(assignments),
    )
    return {"agents": agents, "skills": skills, "assignments": assignments}
