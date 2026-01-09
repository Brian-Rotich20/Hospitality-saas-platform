import { eq } from 'drizzle-orm';
import { db } from '../../config/database';
import { users } from '../../db/schema';
import { hashPassword, comparePassword } from '../../utils/password';
import { signToken } from '../../utils/jwt';
import type { RegisterInput, LoginInput } from './auth.schema';

export class AuthService {
  async register(data: RegisterInput) {
    const existingUser = await db.query.users.findFirst({
      where: eq(users.email, data.email),
    });

    if (existingUser) {
      throw new Error('User already exists');
    }

    const passwordHash = await hashPassword(data.password);

    const [user] = await db
      .insert(users)
      .values({
        email: data.email,
        phone: data.phone,
        passwordHash,
        role: data.role,
      })
      .returning({
        id: users.id,
        email: users.email,
        role: users.role,
      });

    if (!user) {
      throw new Error("User creation failed");
    }

    const token = signToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });


    return { user, token };
  }

  async login(data: LoginInput) {
    const user = await db.query.users.findFirst({
      where: eq(users.email, data.email),
    });

    if (!user) {
      throw new Error('Invalid credentials');
    }

    const isValidPassword = await comparePassword(data.password, user.passwordHash);

    if (!isValidPassword) {
      throw new Error('Invalid credentials');
    }

    const token = signToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    return { user, token };
  }
}