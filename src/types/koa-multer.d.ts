declare module '@koa/multer' {
  import { Middleware } from 'koa'

  interface StorageEngine { }

  interface Options {
    storage?: StorageEngine
    limits?: {
      fileSize?: number
      files?: number
    }
    fileFilter?: (req: any, file: any, cb: (err: Error | null, accept: boolean) => void) => void
  }

  interface Multer {
    single(fieldname: string): Middleware
    array(fieldname: string, maxCount?: number): Middleware
    fields(fields: Array<{ name: string; maxCount?: number }>): Middleware
    none(): Middleware
  }

  interface MulterStatic {
    (options?: Options): Multer
    memoryStorage(): StorageEngine
    diskStorage(options: { destination?: any; filename?: any }): StorageEngine
  }

  const multer: MulterStatic
  export = multer
}
