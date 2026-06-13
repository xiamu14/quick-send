export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

export function errorPayload(error: unknown) {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message } },
    };
  }
  console.error(error);
  return {
    status: 500,
    body: {
      error: { code: "INTERNAL_ERROR", message: "Something went wrong" },
    },
  };
}
