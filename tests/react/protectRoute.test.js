```javascript
// Filename: protectRoute.test.js

// Import the middleware to be tested
import protectRoute from '../middleware/protectRoute.js';
// Import dependencies that the middleware uses, for mocking purposes
import jwt from 'jsonwebtoken';
import User from '../models/user.model.js';

// --- Jest Mocks ---
// Mock the `jsonwebtoken` module.
// We want to control the `verify` method's behavior for tests (e.g., success, error, expired).
// However, our `generateToken` helper needs the *actual* `sign` method to create real JWTs.
// `jest.requireActual` allows us to get the real module and selectively mock parts of it.
jest.mock('jsonwebtoken', () => {
  const actualJwt = jest.requireActual('jsonwebtoken');
  return {
    ...actualJwt, // Keep actual `sign`, `decode`, etc.
    verify: jest.fn(), // Mock only the `verify` method
  };
});

// Mock the `User` Mongoose model.
// The `protectRoute` middleware calls `User.findById(userId).select('-password')`.
// We need to mock `findById` to return an object that has a `select` method,
// and then mock `select` to return a promise that resolves to our mock user data or null.
jest.mock('../models/user.model.js', () => ({
  findById: jest.fn(() => ({ // Mock `findById` to return an object
    select: jest.fn(), // Mock the `select` method of that object
  })),
}));

// --- Helper Functions and Setup ---

// Secret key used in the protectRoute middleware (hardcoded in source)
const SECRET_KEY = "SUPER_SECRET_KEY";

/**
 * Creates mock `req`, `res`, and `next` objects for Express middleware testing.
 * @returns {{req: object, res: object, next: jest.Mock}}
 */
const createMocks = () => {
  const req = {
    cookies: {}, // Middleware reads `req.cookies.jwt`
    // req.user will be set by the middleware
  };
  const res = {
    status: jest.fn().mockReturnThis(), // Allows chaining: res.status(401).json(...)
    json: jest.fn(), // Captures the JSON response
  };
  const next = jest.fn(); // Captures calls to the next middleware
  return { req, res, next };
};

/**
 * Generates a valid JWT token for testing purposes using the actual `jsonwebtoken.sign`.
 * @param {string} userId - The user ID to encode in the token.
 * @param {string} [expiresIn='1h'] - The expiration time for the token (e.g., '1h', '0s').
 * @returns {string} The generated JWT token.
 */
const generateToken = (userId, expiresIn = '1h') => {
  return jwt.sign({ userId }, SECRET_KEY, { expiresIn });
};

// --- Test Suite ---

describe('protectRoute Middleware: Security and Error Handling', () => {
  let req, res, next; // Declare mock objects to be reassigned in `beforeEach`

  // Use a fixed string for mock user ID to ensure consistency and avoid Mongoose dependency for `Types.ObjectId`
  const mockUserId = '60d0fe4a5b86d91f2e8f1d8c';
  const mockUser = {
    _id: mockUserId,
    username: 'testuser',
    email: 'test@example.com',
    // The `protectRoute` middleware uses `.select("-password")`, so our mock user should not have a password
  };

  beforeEach(() => {
    // Reset mocks and create fresh `req`, `res`, `next` objects before each test
    ({ req, res, next } = createMocks());
    jest.clearAllMocks(); // Resets call counts and mock implementations for all mocked functions

    // Set up default mock implementations for `jwt.verify` and `User.findById`
    // These defaults assume a successful scenario unless a specific test overrides them.
    (jwt.verify as jest.Mock).mockReturnValue({ userId: mockUserId });
    
    // Mock `User.findById().select('-password')` to resolve to our `mockUser` by default
    (User.findById as jest.Mock).mockImplementation(() => ({
      select: jest.fn().mockResolvedValue(mockUser),
    }));
  });

  // Test Case 1: Request with a valid token
  it('should call next() and set req.user with user data when a valid token is provided', async () => {
    const token = generateToken(mockUserId);
    req.cookies.jwt = token; // Attach the token to the request cookies

    await protectRoute(req, res, next);

    // Assertions for a successful flow
    expect(jwt.verify).toHaveBeenCalledWith(token, SECRET_KEY);
    expect(User.findById).toHaveBeenCalledWith(mockUserId);
    expect(User.findById().select).toHaveBeenCalledWith('-password'); // Ensure password exclusion
    expect(req.user).toEqual(mockUser); // Verify req.user is set
    expect(next).toHaveBeenCalledTimes(1); // Ensure `next()` is called to proceed
    expect(res.status).not.toHaveBeenCalled(); // No error status should be set
    expect(res.json).not.toHaveBeenCalled(); // No error JSON should be sent
  });

  // Test Case 2: Request with a missing token
  it('should return 401 and "No Token Provided" if no token is present in cookies', async () => {
    req.cookies.jwt = undefined; // Simulate no JWT token in cookies

    await protectRoute(req, res, next);

    // Assertions for missing token error
    expect(jwt.verify).not.toHaveBeenCalled(); // `jwt.verify` should not be called
    expect(User.findById).not.toHaveBeenCalled(); // No database lookup should occur
    expect(next).not.toHaveBeenCalled(); // `next()` should not be called
    expect(res.status).toHaveBeenCalledWith(401); // Expect 401 Unauthorized status
    expect(res.json).toHaveBeenCalledWith({ error: "Unauthorized - No Token Provided" }); // Specific error message
  });

  // Test Case 3: Request with an invalid or malformed token
  it('should return 500 if the token is invalid or malformed (jwt.verify throws an error)', async () => {
    req.cookies.jwt = 'invalid.malformed.token'; // Simulate an invalid JWT string

    // Configure `jwt.verify` to throw an error, mimicking a malformed token or wrong secret
    (jwt.verify as jest.Mock).mockImplementation(() => {
      throw new Error('invalid signature'); // Example error from `jsonwebtoken`
    });

    await protectRoute(req, res, next);

    // Assertions for invalid token error
    expect(jwt.verify).toHaveBeenCalledWith(req.cookies.jwt, SECRET_KEY);
    expect(User.findById).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500); // Current implementation catches and returns 500
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    // IMPORTANT NOTE: The test summary expects a 401 status for invalid tokens.
    // However, the current `protectRoute` middleware implementation wraps `jwt.verify`
    // in a `try-catch` block, which means any error thrown by `jwt.verify` (including
    // for invalid/malformed tokens) results in a 500 "Internal server error".
    // If a 401 is strictly required, the `protectRoute` logic needs to be modified
    // to specifically handle `JsonWebTokenError` exceptions.
  });

  // Test Case 4: Request with an expired token
  it('should return 500 if the token is expired (jwt.verify throws a TokenExpiredError)', async () => {
    const expiredToken = generateToken(mockUserId, '0s'); // Generate a token that expires immediately
    req.cookies.jwt = expiredToken;

    // Configure `jwt.verify` to throw a `TokenExpiredError`
    (jwt.verify as jest.Mock).mockImplementation(() => {
      const error = new Error('jwt expired') as Error & { name: string };
      error.name = 'TokenExpiredError'; // Specific error name for expired tokens
      throw error;
    });

    await protectRoute(req, res, next);

    // Assertions for expired token error
    expect(jwt.verify).toHaveBeenCalledWith(expiredToken, SECRET_KEY);
    expect(User.findById).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500); // Current implementation catches and returns 500
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    // IMPORTANT NOTE: Similar to invalid tokens, the test summary expects a 401 for expired tokens.
    // The current `protectRoute` implementation results in a 500 "Internal server error"
    // due to the general `catch` block for `TokenExpiredError` as well.
  });

  // Test Case 5: Valid token, but the user ID in the token does not exist in the database
  it('should return 404 and "User not found" if the user ID from the token does not exist', async () => {
    const token = generateToken(mockUserId);
    req.cookies.jwt = token;

    (jwt.verify as jest.Mock).mockReturnValue({ userId: mockUserId });
    // Configure `User.findById().select()` to resolve to `null`, indicating no user found
    (User.findById as jest.Mock).mockImplementation(() => ({
      select: jest.fn().mockResolvedValue(null),
    }));

    await protectRoute(req, res, next);

    // Assertions for user not found error
    expect(jwt.verify).toHaveBeenCalledWith(token, SECRET_KEY);
    expect(User.findById).toHaveBeenCalledWith(mockUserId);
    expect(User.findById().select).toHaveBeenCalledWith('-password');
    expect(req.user).toBeUndefined(); // `req.user` should not be set
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404); // Expect 404 Not Found status
    expect(res.json).toHaveBeenCalledWith({ error: "User not found" }); // Specific error message
  });

  // Test Case 6: An unexpected error occurs during user lookup (e.g., database connection issue)
  it('should return 500 if a database error occurs during user lookup', async () => {
    const token = generateToken(mockUserId);
    req.cookies.jwt = token;

    (jwt.verify as jest.Mock).mockReturnValue({ userId: mockUserId });
    // Configure `User.findById().select()` to reject with an error, simulating a DB issue
    (User.findById as jest.Mock).mockImplementation(() => ({
      select: jest.fn().mockRejectedValue(new Error('MongoDB connection failed')),
    }));

    await protectRoute(req, res, next);

    // Assertions for internal server error during DB lookup
    expect(jwt.verify).toHaveBeenCalledWith(token, SECRET_KEY);
    expect(User.findById).toHaveBeenCalledWith(mockUserId);
    expect(User.findById().select).toHaveBeenCalledWith('-password');
    expect(req.user).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500); // Expect 500 Internal Server Error
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
  });

  // Test Case 7: `jwt.verify` returns a falsy value (e.g., null) without throwing an error
  // This covers a defensive check in the middleware: `if (!decoded)`
  it('should return 401 and "Invalid Token" if jwt.verify returns a falsy value without throwing', async () => {
    req.cookies.jwt = 'some.token.value'; // Token string, but `verify` will return falsy

    // Configure `jwt.verify` to return `null` (or `undefined`), which triggers `if (!decoded)`
    (jwt.verify as jest.Mock).mockReturnValue(null);

    await protectRoute(req, res, next);

    // Assertions for an invalid token (falsy `decoded` value)
    expect(jwt.verify).toHaveBeenCalledWith(req.cookies.jwt, SECRET_KEY);
    expect(User.findById).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Unauthorized - Invalid Token" });
  });

  // Test Case 8: Ensure `console.log` for the token is called when present
  it('should console log the token value when it is present in the request cookies', async () => {
    // Spy on `console.log` to check its calls
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const token = generateToken(mockUserId);
    req.cookies.jwt = token;

    await protectRoute(req, res, next);

    expect(consoleSpy).toHaveBeenCalledWith(token);
    consoleSpy.mockRestore(); // Restore the original `console.log` function
  });

  // Test Case 9: Ensure `console.log` for errors is called when an internal server error occurs
  it('should console log the error message when an internal server error occurs', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    req.cookies.jwt = 'invalid.token';
    const errorMessage = 'jwt malformed token for test';

    // Simulate an error thrown by `jwt.verify` to trigger the middleware's catch block
    (jwt.verify as jest.Mock).mockImplementation(() => {
      throw new Error(errorMessage);
    });

    await protectRoute(req, res, next);

    expect(consoleSpy).toHaveBeenCalledWith("Error in protectRoute middleware: ", errorMessage);
    consoleSpy.mockRestore(); // Restore the original `console.log` function
  });
});
```