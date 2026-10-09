import { handleReaderRead } from '../../../../../server/reader-api.js';

export const onRequestPost = ({ request, env, params }) => handleReaderRead(request, env, String(params.id));
