from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from core.database import AgentTable, AttachmentTable, ConversationTable, MessageTable, UserTable
from schemas import WorkspaceSearchResult
from utils.conversations import _preview


def clean_search_query(value: str) -> str:
    return " ".join((value or "").strip().split())


def build_like_pattern(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def resolve_search_conversation_title(conversation: ConversationTable) -> str:
    title = (conversation.title or "").strip()
    if title:
        return title
    preview = (conversation.last_message_preview or "").strip()
    if preview:
        return _preview(preview, 72)
    return conversation.agent.name if conversation.agent else (conversation.agent_name or "Untitled chat")


async def search_workspace_data(
    *,
    db: AsyncSession,
    current_user: UserTable,
    query: str,
    limit: int,
) -> list[WorkspaceSearchResult]:
    pattern = build_like_pattern(query)
    per_kind_limit = max(3, limit)
    results: list[WorkspaceSearchResult] = []

    conversation_stmt = (
        select(ConversationTable)
        .options(selectinload(ConversationTable.agent))
        .where(
            ConversationTable.user_id == current_user.id,
            ConversationTable.is_private == False,
            ConversationTable.is_archived == False,
            or_(
                ConversationTable.title.ilike(pattern, escape="\\"),
                ConversationTable.last_message_preview.ilike(pattern, escape="\\"),
                ConversationTable.agent_name.ilike(pattern, escape="\\"),
            ),
        )
        .order_by(ConversationTable.updated_at.desc())
        .limit(per_kind_limit)
    )
    conversations = (await db.execute(conversation_stmt)).scalars().all()
    for conversation in conversations:
        title = resolve_search_conversation_title(conversation)
        results.append(
            WorkspaceSearchResult(
                kind="conversation",
                id=conversation.id,
                conversationId=conversation.id,
                agentId=conversation.agent_id,
                title=title,
                subtitle=conversation.agent.name if conversation.agent else conversation.agent_name,
                snippet=_preview(conversation.last_message_preview),
                updatedAt=conversation.updated_at,
            )
        )

    message_stmt = (
        select(MessageTable)
        .join(MessageTable.conversation)
        .options(selectinload(MessageTable.conversation).selectinload(ConversationTable.agent))
        .where(
            ConversationTable.user_id == current_user.id,
            ConversationTable.is_private == False,
            ConversationTable.is_archived == False,
            MessageTable.content.ilike(pattern, escape="\\"),
        )
        .order_by(MessageTable.updated_at.desc())
        .limit(per_kind_limit)
    )
    messages = (await db.execute(message_stmt)).scalars().all()
    for message in messages:
        conversation = message.conversation
        sender = "You" if message.sender == "user" else "Assistant"
        results.append(
            WorkspaceSearchResult(
                kind="message",
                id=message.id,
                conversationId=conversation.id,
                agentId=conversation.agent_id,
                title=resolve_search_conversation_title(conversation),
                subtitle=f"{sender} message",
                snippet=_preview(message.content),
                updatedAt=message.updated_at,
            )
        )

    file_stmt = (
        select(AttachmentTable)
        .join(AttachmentTable.message)
        .join(MessageTable.conversation)
        .options(
            selectinload(AttachmentTable.message)
            .selectinload(MessageTable.conversation)
            .selectinload(ConversationTable.agent)
        )
        .where(
            ConversationTable.user_id == current_user.id,
            ConversationTable.is_private == False,
            ConversationTable.is_archived == False,
            AttachmentTable.file_name.ilike(pattern, escape="\\"),
        )
        .order_by(AttachmentTable.updated_at.desc())
        .limit(per_kind_limit)
    )
    attachments = (await db.execute(file_stmt)).scalars().all()
    for attachment in attachments:
        conversation = attachment.message.conversation
        results.append(
            WorkspaceSearchResult(
                kind="file",
                id=attachment.id,
                conversationId=conversation.id,
                agentId=conversation.agent_id,
                title=attachment.file_name,
                subtitle=resolve_search_conversation_title(conversation),
                snippet=attachment.mime_type,
                updatedAt=attachment.updated_at,
            )
        )

    agent_stmt = (
        select(AgentTable)
        .where(
            AgentTable.is_active == True,
            or_(
                AgentTable.name.ilike(pattern, escape="\\"),
                AgentTable.description.ilike(pattern, escape="\\"),
            ),
        )
        .order_by(AgentTable.name.asc())
        .limit(per_kind_limit)
    )
    agents = (await db.execute(agent_stmt)).scalars().all()
    for agent in agents:
        results.append(
            WorkspaceSearchResult(
                kind="agent",
                id=agent.id,
                agentId=agent.id,
                title=agent.name,
                subtitle="Agent",
                snippet=_preview(agent.description),
                updatedAt=agent.updated_at,
            )
        )

    results.sort(key=lambda item: item.updatedAt.timestamp() if item.updatedAt else 0, reverse=True)
    return results[:limit]
