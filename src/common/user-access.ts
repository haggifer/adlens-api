import { HttpStatus } from '@nestjs/common'
import { RequestErrorCode } from 'adlens-shared'
import { type Connection, Types } from 'mongoose'
import { USER_COLLECTION, type UserExtras } from '../database/user.doc'
import { ApiException } from './api-exception'

type AccessFields = Pick<UserExtras, 'isAdmin' | 'isAnonymous' | 'emailVerified'>

// Which limits apply to a user, read from their document in Better Auth's `user` collection (never from the client).
export enum UserAccess {
    Admin = 'admin',
    Member = 'member',
    // An email-and-password account that hasn't confirmed its email yet.
    Unconfirmed = 'unconfirmed',
    Anonymous = 'anonymous',
}

export const USER_ACCESS_PROJECTION = { isAdmin: 1, isAnonymous: 1, emailVerified: 1 }

// Better Auth always stores `emailVerified`; a document without it is read as unconfirmed, the more limited choice.
export const getUserAccess = (user: Partial<AccessFields> | null): UserAccess => {
    if (user?.isAdmin) {
        return UserAccess.Admin
    }

    if (user?.isAnonymous) {
        return UserAccess.Anonymous
    }

    return user?.emailVerified ? UserAccess.Member : UserAccess.Unconfirmed
}

export const readUserAccess = async (connection: Connection, userId: string): Promise<UserAccess> => {
    const user = await connection
        .collection<UserExtras>(USER_COLLECTION)
        .findOne({ _id: new Types.ObjectId(userId) }, { projection: USER_ACCESS_PROJECTION })

    return getUserAccess(user)
}

// Until it confirms its email, an account is limited exactly like an anonymous user.
export const isProvisional = (access: UserAccess): boolean =>
    access === UserAccess.Anonymous || access === UserAccess.Unconfirmed

// A limit for provisional users was reached: the next step is to sign up, or to confirm the account's email.
export const toProvisionalRefusal = (access: UserAccess): ApiException =>
    access === UserAccess.Unconfirmed
        ? new ApiException(
              HttpStatus.TOO_MANY_REQUESTS,
              RequestErrorCode.EmailConfirmationRequired,
              'Confirm your email to keep analysing',
          )
        : new ApiException(HttpStatus.TOO_MANY_REQUESTS, RequestErrorCode.SignUpRequired, 'Sign up to keep analysing')
