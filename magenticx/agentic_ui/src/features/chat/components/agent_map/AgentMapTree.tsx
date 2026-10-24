import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ChevronRight, History } from "lucide-react";

import { cn } from "@/shared/lib/utils";
import { Orb } from "@/shared/ui/orb";
import {
  AGENT_MAP_ROOT_ID as ROOT_ID,
  answerItemId,
  type AgentMap,
  type AgentMapAnswer,
  type AgentMapNode,
} from "@/features/chat/lib/agentMap";
import { AgentNodeCard } from "./AgentNodeCard";
import { Collapse } from "../Collapse";

// The agent map's tree view: the main agent, one branch per answer that used
// sub-agents ("Q3 · …"), and under each its sub-agents with theirs nested
// below. A WAI-ARIA tree: one tab stop (roving tabindex), arrow keys move and
// open/close branches, Enter opens a sub-agent (or toggles an answer), Home and
// End jump. Branch open/closed state and the focused row live in the panel, so
// they survive a trip to a sub-agent's detail and back.

const EASE = [0.22, 1, 0.36, 1] as const;
// Indents line the connector rail up under the parent row's icon; a phone
// trades that for room, so deep branches keep their names readable.
const ROOT_GROUP_INDENT = "[--am-indent:1.5rem]";
const ANSWER_GROUP_INDENT = "[--am-indent:1rem] max-sm:[--am-indent:0.75rem]";
const NODE_GROUP_INDENT = "[--am-indent:1.8rem] max-sm:[--am-indent:1rem]";

type VisibleItem = {
  id: string;
  parent: string | null;
  /** Has children that can show or hide. */
  branch: boolean;
  node?: AgentMapNode;
  answer?: AgentMapAnswer;
};

/** The rows the keyboard can reach, in reading order, given which are closed. */
function visibleItems(answers: AgentMapAnswer[], collapsed: Set<string>): VisibleItem[] {
  const items: VisibleItem[] = [{ id: ROOT_ID, parent: null, branch: false }];
  const visitNodes = (nodes: AgentMapNode[], parent: string) => {
    for (const node of nodes) {
      items.push({ id: node.id, parent, branch: node.children.length > 0, node });
      if (node.children.length && !collapsed.has(node.id)) visitNodes(node.children, node.id);
    }
  };
  for (const answer of answers) {
    const id = answerItemId(answer);
    items.push({ id, parent: ROOT_ID, branch: true, answer });
    if (!collapsed.has(id)) visitNodes(answer.nodes, id);
  }
  return items;
}

type AgentMapTreeProps = {
  map: AgentMap;
  agentName: string;
  /** Answers hidden above the "Show earlier answers" row. */
  hiddenAnswers: number;
  onShowEarlier: () => void;
  answers: AgentMapAnswer[];
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onOpenNode: (id: string) => void;
  focusedId: string;
  onFocusChange: (id: string) => void;
  /** Play the staggered entrance (the first time the tree shows). */
  reveal: boolean;
  now: number;
};

export function AgentMapTree({
  map,
  agentName,
  hiddenAnswers,
  onShowEarlier,
  answers,
  collapsed,
  onToggle,
  onOpenNode,
  focusedId,
  onFocusChange,
  reveal,
  now,
}: AgentMapTreeProps) {
  const reduceMotion = useReducedMotion();
  // Read once: rows that arrive later (a live run) or a remount on the way
  // back from a sub-agent just appear.
  const [playReveal] = React.useState(reveal);
  const itemRefs = React.useRef(new Map<string, HTMLElement>());
  const items = React.useMemo(() => visibleItems(answers, collapsed), [answers, collapsed]);
  const order = React.useMemo(() => new Map(items.map((item, index) => [item.id, index])), [items]);
  // A row that went away (its branch closed, the branch switched) hands the
  // tab stop to the root.
  const activeId = order.has(focusedId) ? focusedId : ROOT_ID;

  const setRef = (id: string) => (element: HTMLElement | null) => {
    if (element) itemRefs.current.set(id, element);
    else itemRefs.current.delete(id);
  };

  const focusItem = (id: string) => {
    onFocusChange(id);
    itemRefs.current.get(id)?.focus({ preventScroll: false });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const index = order.get(activeId) ?? 0;
    const item = items[index];
    if (!item) return;
    const isOpen = item.branch && !collapsed.has(item.id);
    let handled = true;
    switch (event.key) {
      case "ArrowDown":
        if (index < items.length - 1) focusItem(items[index + 1].id);
        break;
      case "ArrowUp":
        if (index > 0) focusItem(items[index - 1].id);
        break;
      case "Home":
        focusItem(items[0].id);
        break;
      case "End":
        focusItem(items[items.length - 1].id);
        break;
      case "ArrowRight":
        if (item.branch && !isOpen) onToggle(item.id);
        else if (items[index + 1]?.parent === item.id) focusItem(items[index + 1].id);
        break;
      case "ArrowLeft":
        if (isOpen) onToggle(item.id);
        else if (item.parent) focusItem(item.parent);
        break;
      case "Enter":
      case " ":
        if (item.node) onOpenNode(item.node.id);
        else if (item.answer) onToggle(item.id);
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  // The entrance: rows fade and slide in, one after another, the first time
  // the map opens — not again when coming back from a sub-agent.
  const rowMotion = (id: string) => {
    if (!playReveal) return { initial: false as const };
    const position = Math.min(order.get(id) ?? 0, 14);
    return {
      initial: reduceMotion ? { opacity: 0 } : { opacity: 0, x: -8 },
      animate: { opacity: 1, x: 0 },
      transition: { duration: 0.32, ease: EASE, delay: reduceMotion ? 0 : 0.06 + position * 0.035 },
    };
  };

  const renderNodes = (nodes: AgentMapNode[], level: number, indent: string) => (
    <ul role="group" className={cn("agent-map-group", indent)}>
      {nodes.map((node) => {
        const open = !collapsed.has(node.id);
        return (
          <li
            key={node.id}
            ref={setRef(node.id)}
            role="treeitem"
            aria-level={level}
            aria-expanded={node.children.length ? open : undefined}
            aria-selected={false}
            aria-label={`${node.title}${node.status ? `, ${node.status.replace("_", " ")}` : ""}${node.task ? `: ${node.task}` : ""}`}
            tabIndex={activeId === node.id ? 0 : -1}
            data-active={node.status === "running" ? "true" : undefined}
            className="agent-map-branch agent-map-item [--am-elbow:2.125rem] pt-1.5"
            onFocus={(event) => {
              if (event.target === event.currentTarget) onFocusChange(node.id);
            }}
          >
            <motion.div
              {...rowMotion(node.id)}
              className="group/node agent-map-row cursor-pointer rounded-2xl"
              onClick={() => {
                onFocusChange(node.id);
                onOpenNode(node.id);
              }}
            >
              <AgentNodeCard
                node={node}
                now={now}
                expanded={open}
                onToggle={node.children.length ? () => onToggle(node.id) : undefined}
              />
            </motion.div>
            {node.children.length ? (
              <Collapse open={open}>
                {renderNodes(node.children, level + 1, NODE_GROUP_INDENT)}
              </Collapse>
            ) : null}
          </li>
        );
      })}
    </ul>
  );

  return (
    // pt: room above the root's orb for its halo, which the scroll area clips.
    <div role="tree" aria-label="Agent map" onKeyDown={handleKeyDown} className="pb-4 pr-1 pt-3">
      {/* The main agent: the root every branch hangs from. */}
      <div
        ref={setRef(ROOT_ID)}
        role="treeitem"
        aria-level={1}
        aria-expanded
        aria-selected={false}
        aria-label={`${agentName}, main agent, ${map.subagentCount} sub-agent${map.subagentCount === 1 ? "" : "s"}`}
        tabIndex={activeId === ROOT_ID ? 0 : -1}
        onFocus={(event) => {
          if (event.target === event.currentTarget) onFocusChange(ROOT_ID);
        }}
        className="agent-map-item"
      >
        <motion.div
          {...rowMotion(ROOT_ID)}
          className="agent-map-row flex items-center gap-3 rounded-2xl px-1 py-1"
        >
          <Orb size={40} state={map.runningCount ? "thinking" : "idle"} className="flex-shrink-0" />
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold tracking-tight text-foreground">
              {agentName}
            </p>
            <p className="truncate text-xs text-muted-foreground tabular-nums">
              Main agent · {map.subagentCount} sub-agent{map.subagentCount === 1 ? "" : "s"} in{" "}
              {map.answers.length} answer{map.answers.length === 1 ? "" : "s"}
              {map.runningCount ? (
                <span className="text-[hsl(var(--subagent-active))]">
                  {" "}
                  · {map.runningCount} working
                </span>
              ) : null}
            </p>
          </div>
        </motion.div>

        <ul role="group" className={cn("agent-map-group", ROOT_GROUP_INDENT)}>
          {hiddenAnswers > 0 ? (
            <li role="none" className="agent-map-branch [--am-elbow:1.75rem] pt-1.5">
              <button
                type="button"
                onClick={onShowEarlier}
                className="flex h-11 items-center gap-2 rounded-xl px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
              >
                <History className="h-3.5 w-3.5" aria-hidden />
                Show {hiddenAnswers} earlier answer{hiddenAnswers === 1 ? "" : "s"}
              </button>
            </li>
          ) : null}
          {answers.map((answer) => {
            const id = answerItemId(answer);
            const open = !collapsed.has(id);
            const working = answer.runningCount > 0;
            return (
              <li
                key={id}
                ref={setRef(id)}
                role="treeitem"
                aria-level={2}
                aria-expanded={open}
                aria-selected={false}
                aria-label={`Question ${answer.number}: ${answer.question || "untitled"}, ${answer.subagentCount} sub-agent${answer.subagentCount === 1 ? "" : "s"}`}
                tabIndex={activeId === id ? 0 : -1}
                data-active={working ? "true" : undefined}
                className="agent-map-branch agent-map-item [--am-elbow:1.75rem] pt-1.5"
                onFocus={(event) => {
                  if (event.target === event.currentTarget) onFocusChange(id);
                }}
              >
                <motion.div
                  {...rowMotion(id)}
                  onClick={() => {
                    onFocusChange(id);
                    onToggle(id);
                  }}
                  className="agent-map-row group/answer flex h-11 cursor-pointer items-center gap-2.5 rounded-xl px-2 transition-colors supports-[hover:hover]:hover:bg-[hsl(var(--hover-surface))]"
                >
                  <ChevronRight
                    aria-hidden
                    className={cn(
                      "h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform duration-200",
                      open && "rotate-90",
                    )}
                  />
                  <span className="flex-shrink-0 rounded-md bg-primary/[0.1] px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-primary">
                    Q{answer.number}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">
                    {answer.question || "Untitled question"}
                  </span>
                  {answer.live ? (
                    <span className="flex flex-shrink-0 items-center gap-1.5 rounded-full bg-[hsl(var(--subagent-active)/0.12)] px-2 py-0.5 text-[11px] font-medium text-[hsl(var(--subagent-active))]">
                      <span className="relative flex h-1.5 w-1.5">
                        <span className="absolute inline-flex h-full w-full rounded-full bg-current opacity-70 motion-safe:animate-ping" />
                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
                      </span>
                      Live
                    </span>
                  ) : null}
                  <span className="flex-shrink-0 text-xs tabular-nums text-muted-foreground">
                    {answer.subagentCount}
                    <span className="hidden sm:inline">
                      {" "}
                      sub-agent{answer.subagentCount === 1 ? "" : "s"}
                    </span>
                  </span>
                </motion.div>
                <Collapse open={open}>{renderNodes(answer.nodes, 3, ANSWER_GROUP_INDENT)}</Collapse>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
