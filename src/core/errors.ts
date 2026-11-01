import type { DocumentKey } from './model.js';

export class StorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}
export class StorageAccessError extends StorageError {}
export class StorageUnavailableError extends StorageError {}
export class StorageOperationError extends StorageError {}
export class DocumentNotFoundError extends StorageError {
  constructor(readonly documentKey: DocumentKey) {
    super(`Document not found: ${documentKey.collection}/${documentKey.id}`);
  }
}
export class PersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}
export class PartialFailureError extends PersistenceError {
  constructor(
    message: string,
    readonly documentKey: DocumentKey,
    cause: unknown,
  ) {
    super(message, { cause });
  }
}
export class InconsistentStateError extends PersistenceError {
  constructor(
    message: string,
    readonly documentKey: DocumentKey,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}
export class AdmissionRejectedError extends PersistenceError {}
