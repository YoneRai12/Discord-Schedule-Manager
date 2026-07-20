function safeErrorCode(error) {
  return String(error?.code || error?.status || error?.name || "unknown")
    .replace(/[^A-Za-z0-9_.-]/gu, "_")
    .slice(0, 80) || "unknown";
}

function disableSheetsSync(sheetsSync) {
  try { sheetsSync?.close?.(); } catch {}
  // GoogleSheetsSync intentionally treats SQLite as the source of truth. Clearing
  // the API object makes later requestSync calls a no-op after startup fallback.
  if (sheetsSync && typeof sheetsSync === "object") sheetsSync.api = null;
}

export async function initializeOptionalSheets({
  sheetsSync,
  intervalMs,
  logger = console,
  setIntervalImpl = setInterval,
} = {}) {
  if (!sheetsSync?.configured) return { enabled: false, interval: null, errorCode: null };
  try {
    await sheetsSync.initialize();
    await sheetsSync.sync();
  } catch (error) {
    const errorCode = safeErrorCode(error);
    disableSheetsSync(sheetsSync);
    logger.warn?.(`[sheets] 初期化または初回同期に失敗しました code=${errorCode}; Sheetsを無効化してDiscord BOTは継続します`);
    return { enabled: false, interval: null, errorCode };
  }

  const interval = setIntervalImpl(() => {
    void sheetsSync.sync().catch((error) => {
      const code = safeErrorCode(error);
      logger.error?.(`[sheets] 定期同期失敗 code=${code}`);
    });
  }, intervalMs);
  interval?.unref?.();
  return { enabled: true, interval, errorCode: null };
}

export async function stopSchedulerAndDrain(scheduler, {
  timeoutMs = 10_000,
  label = "scheduler",
  logger = console,
} = {}) {
  if (!scheduler) return true;
  try {
    if (typeof scheduler.stopAndDrain === "function") {
      const drained = await scheduler.stopAndDrain(timeoutMs);
      if (drained === false) {
        logger.warn?.(`[shutdown] ${label} drain incomplete code=drain_timeout`);
        return false;
      }
    } else {
      scheduler.stop?.();
    }
    return true;
  } catch (error) {
    logger.warn?.(`[shutdown] ${label} drain failed code=${safeErrorCode(error)}`);
    return false;
  }
}

export { safeErrorCode };
