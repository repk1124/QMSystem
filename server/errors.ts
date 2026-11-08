/**
 * 應用層錯誤。
 *
 * 重點是「業務規則被違反」跟「程式壞掉」要分得開 ——
 * 前者該回 4xx 並且訊息可以直接給使用者看，後者該回 500 並且
 * 只在伺服器日誌留下細節（避免把資料庫結構洩漏給前端）。
 */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super(`找不到${what}`, 404, "not_found");
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, "validation_error", details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "權限不足") {
    super(message, 403, "forbidden");
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "請先登入") {
    super(message, 401, "unauthorized");
  }
}

/** 業務規則衝突，例如想改一張已鎖定的報價 */
export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 409, "conflict", details);
  }
}
