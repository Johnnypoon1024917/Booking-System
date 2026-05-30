// Thin alias over react-i18next's useTranslation. We re-export so pages
// can `import { useT } from '../hooks/useT'` without thinking about the
// underlying library, which simplifies a later swap (e.g. to FormatJS).
import { useTranslation } from 'react-i18next';

export const useT = () => useTranslation();
export default useT;
