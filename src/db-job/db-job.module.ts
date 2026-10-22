import { Module } from '@nestjs/common'
import { appConfigModule } from '../config/env'
import { DatabaseModule } from '../database/database.module'

// Composition root of the database job (db.ts): the connection with every model registered, whose indexes and
// validators it syncs.
@Module({ imports: [appConfigModule, DatabaseModule] })
export class DbJobModule {}
