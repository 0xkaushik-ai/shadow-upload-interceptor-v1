import { defineContentScript } from '#imports';
import { CONTENT_SCRIPT_MATCHES } from '../bridge/policy';
import { installUploadGuard } from '../intercept/uploadGuard';

export default defineContentScript({
  matches: [...CONTENT_SCRIPT_MATCHES],
  runAt: 'document_start',
  allFrames: true,
  main(ctx) {
    const remove = installUploadGuard();
    ctx.onInvalidated(remove);
  },
});
