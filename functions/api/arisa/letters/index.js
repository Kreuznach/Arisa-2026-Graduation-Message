import { handleReaderList } from '../../../../server/reader-api.js';

export const onRequestGet = ({ request, env }) => handleReaderList(request, env);
