declare module "mpyqjs2/mpyq.js" {
  export class MPQArchive {
    constructor(source: string | Buffer, listfile?: boolean);
    header: { userDataHeader?: { content: Buffer } };
    readFile(name: string): Buffer | null;
  }
}
