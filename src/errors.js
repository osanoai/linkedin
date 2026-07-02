export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export class UsageError extends CliError {
  constructor(message) {
    super(message, 2);
  }
}

export class AuthError extends CliError {
  constructor(message) {
    super(message, 3);
  }
}

export class ApiError extends CliError {
  constructor(message, status, body) {
    super(message, 1);
    this.status = status;
    this.body = body;
  }
}
