/**
 * Environment Variable Validation
 * Validates required environment variables at startup
 */

interface ValidationResult {
  errors: string[];
  warnings: string[];
  features: Record<string, boolean>;
}

const REQUIRED_VARS: Record<string, string[]> = {
  production: [
    'DATABASE_URL',
    'REDIS_URL',
    'SESSION_SECRET',
  ],
  optional: [
    'GITHUB_APP_ID',
    'GITHUB_PRIVATE_KEY',
    'GITHUB_WEBHOOK_SECRET',
    'GITHUB_OAUTH_CLIENT_ID',
    'GITHUB_OAUTH_CLIENT_SECRET',
    'OPENAI_API_KEY',
  ],
};

const WARNINGS: Record<string, (value: string | undefined) => string | null> = {
  SESSION_SECRET: (value: string | undefined): string | null => {
    if (value === 'dev-session-secret-change-in-prod') {
      return 'Using default session secret - change this in production!';
    }
    if (value && value.length < 32) {
      return 'Session secret should be at least 32 characters for security';
    }
    return null;
  },
  DATABASE_URL: (value: string | undefined): string | null => {
    if (value && value.includes('localhost') && process.env.NODE_ENV === 'production') {
      return 'Using localhost database in production environment';
    }
    return null;
  },
};

export function validateEnvironment(): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const isProduction = process.env.NODE_ENV === 'production';

  // Check required variables in production
  if (isProduction) {
    for (const varName of REQUIRED_VARS.production) {
      if (!process.env[varName]) {
        errors.push(`Missing required environment variable: ${varName}`);
      }
    }
  }

  // Check for warnings on all variables
  for (const [varName, checkFn] of Object.entries(WARNINGS)) {
    const value = process.env[varName];
    const warning = checkFn(value);
    if (warning) {
      warnings.push(`${varName}: ${warning}`);
    }
  }

  // Log feature status based on optional variables
  const features = {
    'GitHub App Integration': !!process.env.GITHUB_APP_ID,
    'GitHub OAuth': !!process.env.GITHUB_OAUTH_CLIENT_ID,
    'Semantic Search': !!process.env.OPENAI_API_KEY,
  };

  return { errors, warnings, features };
}

export function printEnvironmentStatus(): void {
  const { errors, warnings, features } = validateEnvironment();

  console.log('\n=== BotHub Environment Status ===\n');

  // Print errors
  if (errors.length > 0) {
    console.log('ERRORS:');
    errors.forEach(err => console.log(`  ❌ ${err}`));
    console.log('');
  }

  // Print warnings
  if (warnings.length > 0) {
    console.log('WARNINGS:');
    warnings.forEach(warn => console.log(`  ⚠️  ${warn}`));
    console.log('');
  }

  // Print feature status
  console.log('FEATURES:');
  for (const [feature, enabled] of Object.entries(features)) {
    const status = enabled ? '✅' : '⬚';
    console.log(`  ${status} ${feature}`);
  }
  console.log('');

  // Fail on errors in production
  if (errors.length > 0 && process.env.NODE_ENV === 'production') {
    console.error('Environment validation failed. Exiting...');
    process.exit(1);
  }
}

export default { validateEnvironment, printEnvironmentStatus };
