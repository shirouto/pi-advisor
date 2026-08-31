import {
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  stream,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { splitRef } from "./config/state.js";

export interface ResolvedConfiguredModel {
  apiKey: string;
  baseUrl?: string;
  env?: Record<string, string>;
  headers?: Record<string, string | null>;
  model: Model<Api>;
  ref: string;
}

export const resolveConfiguredModel = async (
  ctx: ExtensionContext,
  ref: string | undefined,
  label: string
): Promise<ResolvedConfiguredModel> => {
  if (!ref) {
    throw new Error(`${label} model not configured`);
  }
  const [provider, modelId] = splitRef(ref);
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) {
    throw new Error(`${label} model not found: ${ref}`);
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error((auth as { error: string }).error);
  }
  if (!auth.apiKey) {
    throw new Error(`No API key for ${ref}`);
  }
  return {
    apiKey: auth.apiKey,
    baseUrl: auth.baseUrl,
    env: auth.env,
    headers: auth.headers,
    model,
    ref,
  };
};

export interface CollectTextStreamOptions {
  messages: Message[];
  onChunk?: (thinking: string, text: string) => void;
  reasoning?: string;
  signal?: AbortSignal;
  systemPrompt: string;
}

export interface CollectedTextStream {
  text: string;
  thinking: string;
  usage?: unknown;
}

export const ADVISOR_STREAM_UPDATE_INTERVAL_MS = 90;

type TerminalErrorReason = "error" | "aborted";

const terminalStreamError = (
  assistant: AssistantMessage | undefined,
  eventReason: TerminalErrorReason | undefined,
  eventMessage: string | undefined
): Error | undefined => {
  let reason: TerminalErrorReason | undefined;
  if (assistant?.stopReason === "aborted" || eventReason === "aborted") {
    reason = "aborted";
  } else if (assistant?.stopReason === "error" || eventReason === "error") {
    reason = "error";
  }
  if (!reason) {
    return undefined;
  }

  const errorMessage = assistant?.errorMessage ?? eventMessage;
  return new Error(
    errorMessage ??
      (reason === "aborted"
        ? "Advisor request aborted."
        : "Advisor request failed.")
  );
};

export interface CoalescedUpdateResult {
  error?: unknown;
  failed: boolean;
}

export interface CoalescedUpdate<T> {
  cancel: () => void;
  flush: () => CoalescedUpdateResult;
  update: (value: T) => void;
}

export interface CoalescedUpdateScheduler {
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
  now: () => number;
  setTimeout: (
    callback: () => void,
    delay: number
  ) => ReturnType<typeof setTimeout>;
}

/**
 * Keep stream updates responsive without forwarding every provider delta to
 * the UI. The first update in a burst is immediate; later updates are kept as
 * the latest value and published at most once per interval. `flush()` closes
 * the publisher and is intended for terminal success/error paths.
 */
export const createCoalescedUpdate = <T>(
  publish: (value: T) => void,
  intervalMs = ADVISOR_STREAM_UPDATE_INTERVAL_MS,
  scheduler: CoalescedUpdateScheduler = {
    clearTimeout,
    now: Date.now,
    setTimeout: (callback, delay) => setTimeout(callback, delay),
  }
): CoalescedUpdate<T> => {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("Coalesced update interval must be positive and finite.");
  }

  let closed = false;
  let hasPending = false;
  let pending: T | undefined;
  let lastPublishedAt: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let publishError: unknown;
  let publishFailed = false;

  const clearTimer = () => {
    if (timer !== undefined) {
      scheduler.clearTimeout(timer);
      timer = undefined;
    }
  };

  const publishPending = () => {
    timer = undefined;
    if (!hasPending) {
      return;
    }
    const value = pending as T;
    pending = undefined;
    hasPending = false;
    lastPublishedAt = scheduler.now();
    try {
      publish(value);
    } catch (error) {
      publishFailed = true;
      publishError = error;
      closed = true;
      clearTimer();
    }
  };

  const schedule = () => {
    const elapsed =
      lastPublishedAt === undefined
        ? intervalMs
        : scheduler.now() - lastPublishedAt;
    const delay = Math.max(0, intervalMs - elapsed);
    if (delay === 0) {
      publishPending();
      return;
    }
    timer = scheduler.setTimeout(publishPending, delay);
    timer.unref?.();
  };

  return {
    cancel: () => {
      closed = true;
      clearTimer();
      pending = undefined;
      hasPending = false;
    },
    flush: () => {
      if (!closed) {
        closed = true;
        clearTimer();
        publishPending();
      }
      return { error: publishError, failed: publishFailed };
    },
    update: (value) => {
      if (closed) {
        return;
      }
      if (publishFailed) {
        throw publishError;
      }
      pending = value;
      hasPending = true;
      if (timer === undefined) {
        schedule();
      }
      if (publishFailed) {
        throw publishError;
      }
    },
  };
};

export const collectTextStream = async (
  resolved: ResolvedConfiguredModel,
  options: CollectTextStreamOptions,
  streamModel: typeof stream = stream
): Promise<CollectedTextStream> => {
  let thinking = "";
  let text = "";
  let terminalErrorReason: TerminalErrorReason | undefined;
  let terminalErrorMessage: string | undefined;
  const eventStream = streamModel(
    resolved.baseUrl
      ? { ...resolved.model, baseUrl: resolved.baseUrl }
      : resolved.model,
    { messages: options.messages, systemPrompt: options.systemPrompt },
    {
      apiKey: resolved.apiKey,
      env: resolved.env,
      headers: resolved.headers,
      // `stream()` uses the provider-facing name while the extension's public
      // option keeps the Pi-facing `reasoning` name. Preserve both so the
      // configured effort reaches providers that serialize reasoning_effort.
      reasoning: options.reasoning as never,
      ...(options.reasoning === undefined
        ? {}
        : { reasoningEffort: options.reasoning as never }),
      signal: options.signal,
    }
  );

  for await (const event of eventStream) {
    if (event.type === "error") {
      terminalErrorReason = event.reason;
      terminalErrorMessage = event.error.errorMessage;
    } else if (event.type === "thinking_delta") {
      thinking += event.delta;
      options.onChunk?.(thinking, text);
    } else if (event.type === "text_delta") {
      text += event.delta;
      options.onChunk?.(thinking, text);
    }
  }

  const response = await eventStream.result();
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new Error("Advisor operation cancelled.");
  }
  const lastAssistant = [response].find(
    (message): message is AssistantMessage => message.role === "assistant"
  );
  const streamError = terminalStreamError(
    lastAssistant,
    terminalErrorReason,
    terminalErrorMessage
  );
  if (streamError) {
    throw streamError;
  }

  const finalText =
    lastAssistant?.content
      .filter(
        (part): part is { type: "text"; text: string } => part.type === "text"
      )
      .map((part) => part.text)
      .join("\n") || text;
  return {
    text: finalText,
    thinking,
    usage: (
      lastAssistant as (AssistantMessage & { usage?: unknown }) | undefined
    )?.usage,
  };
};
