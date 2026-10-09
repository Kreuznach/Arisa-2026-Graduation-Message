import { handleReaderSession } from '../../../server/reader-api.js';
import { methodNotAllowed } from '../../../server/http.js';

const METHODS = ['GET', 'POST', 'DELETE'];

export const onRequest = ({ request, env }) =>
  METHODS.includes(request.method) ? handleReaderSession(request, env) : methodNotAllowed(METHODS);
