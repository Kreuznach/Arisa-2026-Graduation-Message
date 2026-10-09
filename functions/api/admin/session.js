import { handleAdminSession } from '../../../server/admin-api.js';
import { methodNotAllowed } from '../../../server/http.js';

const METHODS = ['GET', 'POST', 'DELETE'];

export const onRequest = ({ request, env }) =>
  METHODS.includes(request.method) ? handleAdminSession(request, env) : methodNotAllowed(METHODS);
