import { handleAdminLetter, handleAdminSetStatus } from '../../../../server/admin-api.js';

export const onRequestGet = ({ request, env, params }) => handleAdminLetter(request, env, String(params.id));
export const onRequestPatch = ({ request, env, params }) => handleAdminSetStatus(request, env, String(params.id));
