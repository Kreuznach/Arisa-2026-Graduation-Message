import { handleAdminList } from '../../../../server/admin-api.js';

export const onRequestGet = ({ request, env }) => handleAdminList(request, env);
