import type { PageServerLoad } from './$types';
import { countDone, listItems } from '$lib/server/db';

export const load: PageServerLoad = () => {
	return { items: listItems(), doneCount: countDone() };
};
