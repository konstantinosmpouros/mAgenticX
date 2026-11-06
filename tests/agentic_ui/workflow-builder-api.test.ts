// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWorkflow, deleteWorkflow, updateWorkflow, validateWorkflow } from "@/shared/lib/api";
import { ApiError } from "@/shared/lib/http";
import { toWorkflowValidationIssues } from "@/shared/lib/schemas";
import type { WorkflowSpec } from "@/shared/lib/types";

/**
 * The builder's writes (plan 38, step 3): create / update / delete / validate
 * on `/api/v1/workflows…`, each with CSRF; validate's issues mapped; a 422's
 * `detail.errors` readable for the canvas.
 */

const spec: WorkflowSpec = {
  version: 1,
  name: "W",
  description: "",
  inputs: [],
  nodes: [{ id: "trigger", kind: "trigger.manual", label: null, config: {}, position: { x: 0, y: 0 } }],
  edges: [],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  document.cookie = "mx_csrf=tok";
});
afterEach(() => vi.unstubAllGlobals());

const call = (index = 0) => ({
  url: String(fetchMock.mock.calls[index][0]),
  init: fetchMock.mock.calls[index][1] ?? {},
});
const csrfOf = (init: RequestInit) => new Headers(init.headers).get("X-CSRF-Token");

describe("workflow builder API", () => {
  it("creates with POST {spec} and CSRF", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "wf-1", name: "W", spec, latestVersionNo: 1 }, 201));
    const workflow = await createWorkflow("u1", spec);
    const { url, init } = call();
    expect(url).toBe("/api/v1/workflows/u1");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ spec });
    expect(csrfOf(init)).toBe("tok");
    expect(workflow).toMatchObject({ id: "wf-1", latestVersionNo: 1 });
  });

  it("updates with PUT and deletes with DELETE, both with CSRF", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "wf-1", name: "W", latestVersionNo: 2 }));
    expect((await updateWorkflow("u1", "wf-1", spec)).latestVersionNo).toBe(2);
    expect(call(0).url).toBe("/api/v1/workflows/u1/wf-1");
    expect(call(0).init.method).toBe("PUT");
    expect(csrfOf(call(0).init)).toBe("tok");

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await deleteWorkflow("u1", "wf-1");
    expect(call(1).url).toBe("/api/v1/workflows/u1/wf-1");
    expect(call(1).init.method).toBe("DELETE");
    expect(csrfOf(call(1).init)).toBe("tok");
  });

  it("validates, mapping issues (ok only with none)", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ ok: false, errors: [{ nodeId: "a", path: "nodes[0].id", message: "Bad." }, { path: "x" }] }),
    );
    const result = await validateWorkflow(spec);
    expect(call().url).toBe("/api/v1/workflows/validate");
    expect(csrfOf(call().init)).toBe("tok");
    expect(result).toEqual({ ok: false, errors: [{ nodeId: "a", path: "nodes[0].id", message: "Bad." }] });
  });

  it("surfaces a 422's node-addressed errors", async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        { detail: { message: "The workflow is invalid.", errors: [{ node_id: "a", path: "nodes", message: "No." }] } },
        422,
      ),
    );
    const error = await createWorkflow("u1", spec).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
    expect(toWorkflowValidationIssues((error as ApiError).detailObject?.errors)).toEqual([
      { nodeId: "a", path: "nodes", message: "No." },
    ]);
  });
});
