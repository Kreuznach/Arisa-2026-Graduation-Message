import { handleReaderLetter } from '../../../../../server/reader-api.js';

export const onRequestGet = ({ request, env, params }) => handleReaderLetter(request, env, String(params.id));
