import { serve } from './mcp.mjs';
import { DeleteService } from './service.mjs';
import { PipeClient, NativeClient, desktopClient, findCodex } from './transport.mjs';

let pipe;
const service = new DeleteService({
  desktop: {
    async read(caller, target) {
      pipe ??= new PipeClient(process.env.CODEX_APP_TOOLS_PIPE_PATH);
      return desktopClient(pipe).read(caller, target);
    },
  },
  async openNative() {
    const native = new NativeClient(await findCodex());
    try { await native.initialize(); return native; }
    catch (error) { native.close(); throw error; }
  },
});

const { closed } = serve(service);
await closed;
pipe?.close();
