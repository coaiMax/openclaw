import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type BoardActionParams,
  type BoardDataReadParams,
  type BoardEventParams,
  type BoardPromptAuthorizeParams,
  type BoardUpdateParams,
  type BoardWidgetGrantParams,
  type BoardWidgetMaterializedPutParams,
  type BoardWidgetPutParams,
  validateBoardActionParams,
  validateBoardDataReadParams,
  validateBoardEventParams,
  validateBoardGetParams,
  validateBoardPromptAuthorizeParams,
  validateBoardUpdateParams,
  validateBoardWidgetContent,
  validateBoardWidgetGrantParams,
  validateBoardWidgetPutParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  boardWidgetHasGrantedTool,
  normalizeBoardWidgetDeclared,
} from "../../boards/board-capabilities.js";
import { BoardValidationError } from "../../boards/board-layout.js";
import { appendBoardEventNotice, BoardEventPayloadError } from "../../boards/board-notices.js";
import type { BoardStore } from "../../boards/board-store.js";
import { readCanvasDocumentHtmlSource } from "../../canvas/documents.js";
import { buildWidgetDocument } from "../../canvas/wrap.js";
import { readBoardDataBinding, triggerBoardCronJob } from "../board-host-tools.js";
import { buildBoardWidgetSandboxPath } from "../board-sandbox.js";
import { boardStore } from "../board-store.js";
import {
  BOARD_VIEW_TICKET_TTL_MS,
  buildBoardWidgetFrameUrl,
  createBoardViewTicket,
} from "../board-view-ticket.js";
import { resolveAuthorizedBoardWidgetView } from "../board-widget-view.js";
import type { GatewayRequestHandlers } from "./types.js";

type NoticeAppender = typeof appendBoardEventNotice;
type CanvasDocumentReader = typeof readCanvasDocumentHtmlSource;
type BoardDataReader = typeof readBoardDataBinding;
type BoardCronTrigger = typeof triggerBoardCronJob;

function invalidParams(
  method: string,
  errors: unknown,
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
): void {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `invalid ${method} params: ${formatValidationErrors(errors as never)}`,
    ),
  );
}

function respondBoardError(
  error: unknown,
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
): void {
  if (error instanceof BoardValidationError || error instanceof BoardEventPayloadError) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
    return;
  }
  respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
}

export function createBoardHandlers(
  store: BoardStore,
  appendNotice: NoticeAppender = appendBoardEventNotice,
  readCanvasDocument: CanvasDocumentReader = readCanvasDocumentHtmlSource,
  dependencies: {
    readDataBinding?: BoardDataReader;
    triggerCronJob?: BoardCronTrigger;
  } = {},
): GatewayRequestHandlers {
  const readDataBinding = dependencies.readDataBinding ?? readBoardDataBinding;
  const triggerCronJob = dependencies.triggerCronJob ?? triggerBoardCronJob;
  return {
    "board.get": async ({ params, respond, context }) => {
      if (!validateBoardGetParams(params)) {
        invalidParams("board.get", validateBoardGetParams.errors, respond);
        return;
      }
      const snapshot = store.getSnapshot(params.sessionKey);
      let sandboxPort = context.getMcpAppSandboxPort?.();
      for (const widget of snapshot.widgets) {
        if (widget.grantState !== "none" && widget.grantState !== "granted") {
          continue;
        }
        const document = store.readWidgetHtml(snapshot.sessionKey, widget.name);
        if (!document || !("html" in document) || document.revision !== widget.revision) {
          continue;
        }
        if (sandboxPort === undefined && context.ensureSandboxHostPort) {
          try {
            sandboxPort = await context.ensureSandboxHostPort();
          } catch (error) {
            respondBoardError(error, respond);
            return;
          }
        }
        const { ticket } = createBoardViewTicket({
          sessionKey: snapshot.sessionKey,
          name: widget.name,
          revision: widget.revision,
          viewGeneration: document.viewGeneration,
        });
        widget.frameUrl = buildBoardWidgetFrameUrl({
          sessionKey: snapshot.sessionKey,
          name: widget.name,
          ticket,
        });
        widget.viewTicket = ticket;
        widget.viewTicketTtlMs = BOARD_VIEW_TICKET_TTL_MS;
        widget.viewGeneration = document.viewGeneration;
        if (sandboxPort !== undefined) {
          widget.sandboxUrl = buildBoardWidgetSandboxPath(document);
          widget.sandboxPort = sandboxPort;
          const configuredOrigin = context.getRuntimeConfig?.().mcp?.apps?.sandboxOrigin;
          if (configuredOrigin) {
            widget.sandboxOrigin = new URL(configuredOrigin).origin;
          }
        }
      }
      respond(true, snapshot);
    },
    "board.update": ({ params, respond, context }) => {
      if (!validateBoardUpdateParams(params)) {
        invalidParams("board.update", validateBoardUpdateParams.errors, respond);
        return;
      }
      try {
        const boardParams = params as BoardUpdateParams;
        const snapshot = store.applyOps(boardParams.sessionKey, boardParams.ops);
        if (boardParams.ops.length > 0) {
          context.broadcast("board.changed", {
            sessionKey: snapshot.sessionKey,
            revision: snapshot.revision,
          });
        }
        respond(true, snapshot);
      } catch (error) {
        respondBoardError(error, respond);
      }
    },
    "board.widget.put": async ({ params, respond, context }) => {
      if (!validateBoardWidgetPutParams(params)) {
        invalidParams("board.widget.put", validateBoardWidgetPutParams.errors, respond);
        return;
      }
      try {
        const requestParams = params as BoardWidgetPutParams;
        const declared = normalizeBoardWidgetDeclared(requestParams.declared);
        let content: BoardWidgetMaterializedPutParams["content"];
        if (requestParams.content.kind === "canvas-doc") {
          const document = await readCanvasDocument(requestParams.content.docId);
          if (document.cspSandbox !== "scripts") {
            throw new BoardValidationError(
              "invalid_operation",
              `canvas document is not script-enabled: ${requestParams.content.docId}`,
            );
          }
          content = { kind: "html", html: document.html };
        } else {
          content = requestParams.content;
        }
        if (!validateBoardWidgetContent(content)) {
          invalidParams("board.widget.put content", validateBoardWidgetContent.errors, respond);
          return;
        }
        const materializedContent: BoardWidgetMaterializedPutParams["content"] =
          content.kind === "html"
            ? {
                kind: "html",
                // Authority-bearing bridge code must precede every admitted
                // byte, including complete HTML and managed Canvas documents.
                // The wrapper is idempotent so an already-wrapped Canvas view
                // keeps one effective bridge owner.
                html: buildWidgetDocument(requestParams.title ?? requestParams.name, content.html, {
                  connectOrigins: declared?.netOrigins,
                }),
              }
            : content;
        const boardParams: BoardWidgetMaterializedPutParams = {
          ...requestParams,
          content: materializedContent,
        };
        if (declared) {
          boardParams.declared = declared;
        } else {
          delete boardParams.declared;
        }
        const snapshot = store.putWidget(boardParams);
        context.broadcast("board.changed", {
          sessionKey: snapshot.sessionKey,
          revision: snapshot.revision,
          widget: boardParams.name,
        });
        respond(true, snapshot);
      } catch (error) {
        respondBoardError(error, respond);
      }
    },
    "board.widget.grant": ({ params, respond, context }) => {
      if (!validateBoardWidgetGrantParams(params)) {
        invalidParams("board.widget.grant", validateBoardWidgetGrantParams.errors, respond);
        return;
      }
      try {
        const boardParams = params as BoardWidgetGrantParams;
        const snapshot = store.grant(
          boardParams.sessionKey,
          boardParams.name,
          boardParams.decision,
          boardParams.revision,
        );
        context.broadcast("board.changed", {
          sessionKey: snapshot.sessionKey,
          revision: snapshot.revision,
        });
        respond(true, snapshot);
      } catch (error) {
        respondBoardError(error, respond);
      }
    },
    "board.event": ({ params, respond }) => {
      if (!validateBoardEventParams(params)) {
        invalidParams("board.event", validateBoardEventParams.errors, respond);
        return;
      }
      try {
        const boardParams = params as BoardEventParams;
        const identity =
          "ticket" in boardParams
            ? resolveAuthorizedBoardWidgetView(store, boardParams.ticket)
            : (() => {
                const snapshot = store.getSnapshot(boardParams.sessionKey);
                const widget = snapshot.widgets.some(
                  (candidate) => candidate.name === boardParams.widget,
                );
                if (!widget) {
                  throw new BoardValidationError(
                    "not_found",
                    `board widget not found: ${boardParams.widget}`,
                  );
                }
                return { sessionKey: snapshot.sessionKey, name: boardParams.widget };
              })();
        const appended = appendNotice({
          sessionKey: identity.sessionKey,
          widget: identity.name,
          payload: boardParams.payload,
        });
        respond(true, { ok: true, appended });
      } catch (error) {
        respondBoardError(error, respond);
      }
    },
    "board.prompt.authorize": ({ params, respond }) => {
      if (!validateBoardPromptAuthorizeParams(params)) {
        invalidParams("board.prompt.authorize", validateBoardPromptAuthorizeParams.errors, respond);
        return;
      }
      try {
        const boardParams = params as BoardPromptAuthorizeParams;
        const { document } = resolveAuthorizedBoardWidgetView(store, boardParams.ticket);
        respond(true, {
          confirmationRequired: !boardWidgetHasGrantedTool(
            document.declared,
            document.grantState,
            "prompt",
          ),
        });
      } catch (error) {
        respondBoardError(error, respond);
      }
    },
    "board.data.read": async (invocation) => {
      const { params, respond } = invocation;
      if (!validateBoardDataReadParams(params)) {
        invalidParams("board.data.read", validateBoardDataReadParams.errors, respond);
        return;
      }
      try {
        const boardParams = params as BoardDataReadParams;
        const bindingParams = boardParams.params ?? {};
        if (Buffer.byteLength(JSON.stringify(bindingParams), "utf8") > 8 * 1024) {
          throw new BoardValidationError(
            "invalid_operation",
            "board widget data binding params exceed 8192 UTF-8 bytes",
          );
        }
        const { document } = resolveAuthorizedBoardWidgetView(store, boardParams.ticket);
        if (
          !boardWidgetHasGrantedTool(document.declared, document.grantState, boardParams.bindingId)
        ) {
          throw new BoardValidationError(
            "invalid_operation",
            `board widget tool is not granted: ${boardParams.bindingId}`,
          );
        }
        respond(true, await readDataBinding(boardParams.bindingId, bindingParams, invocation));
      } catch (error) {
        respondBoardError(error, respond);
      }
    },
    "board.action": async (invocation) => {
      const { params, respond } = invocation;
      if (!validateBoardActionParams(params)) {
        invalidParams("board.action", validateBoardActionParams.errors, respond);
        return;
      }
      try {
        const boardParams = params as BoardActionParams;
        const { document } = resolveAuthorizedBoardWidgetView(store, boardParams.ticket);
        const capability = `cron.trigger:${boardParams.jobId}`;
        if (!boardWidgetHasGrantedTool(document.declared, document.grantState, capability)) {
          throw new BoardValidationError(
            "invalid_operation",
            `board widget tool is not granted: ${capability}`,
          );
        }
        respond(true, await triggerCronJob(boardParams.jobId, invocation));
      } catch (error) {
        respondBoardError(error, respond);
      }
    },
  };
}

export const boardHandlers = createBoardHandlers(boardStore);
