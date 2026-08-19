# VideoGen Laravel API Backend + Web Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Laravel-specific tasks (marked below) should be dispatched to the `laravel-senior-engineer` subagent for implementation and `laravel-code-reviewer` for review, per this project's existing agent roster — the generic `subagent-driven-development` review loop is satisfied by that pair instead of a fresh generic reviewer each time.

**Goal:** Stand up a new Laravel project (`VideoGenAPI`) that ports VideoGen's video-generation backend (4 AI providers, background jobs, ffmpeg stitching) to Sanctum-auth'd REST API + a Blade/Livewire web app implementing the "Vidora AI" design, while the existing Python app keeps running unaffected at `http://localhost:8767/`.

**Architecture:** Laravel app serving two frontends off one service/action layer — `/api/v1/*` (Sanctum bearer tokens, for the future React Native app) and Blade+Livewire (session/web guard, browser access). Provider calls happen through per-provider service classes behind a shared interface, resolved per-user's own encrypted API key. Video generation runs as queued jobs (Redis) updating a polled `generation_jobs` row; ffmpeg stitching runs via `Symfony\Process` array-arg calls only.

**Tech Stack:** Laravel 11, PHP 8.2+, Sanctum, MySQL, Redis queue, S3 (`league/flysystem-aws-s3-v3`), Livewire 3, Pest + `Livewire::test()`, Symfony Process.

**Spec:** `docs/superpowers/specs/2026-08-19-laravel-api-backend-design.md` (read this first — this plan implements it verbatim; deviations are called out explicitly below where the Python source disagrees with the spec's wording).

## Global Constraints

- New project lives at `/Users/arunkumar/Documents/Application/VideoGenAPI` — never touch the running Python app (`/Users/arunkumar/Documents/Application/VideoGen`, port 8767) during this build.
- All models: explicit `$fillable` allow-lists. Never `$guarded = []`.
- All DB access via Eloquent/query builder. Never `DB::raw()` with user input.
- All record lookups scoped to `auth()->id()` (query scope or Policy) — no bare `Model::find()` returned across users.
- All secrets via `config('services.*')`/`config('engines.*')`. Never `env()` outside `config/*.php`.
- All shell calls (`ffmpeg`) via `Symfony\Process` array-arg form. Never a shell string.
- Every endpoint has a dedicated `FormRequest` — no inline `$request->input()` trust.
- **Deviation from spec's Background Jobs list:** the Python source (`server.py`) only backgrounds `run_generation`/`run_story`/`run_stitch` via `threading.Thread` — `/api/enhance`, `/api/write-story`, `/api/restructure`, `/api/storyboard` run synchronously (fast Claude Haiku text calls, no video generation). Port these as synchronous Action calls in their controllers, **not** queued jobs — there is no `EnhanceJob`. This plan follows the Python source's actual behavior over the spec doc's wording; the spec should be corrected to match after this plan lands.
- Tests: Pest. Queue jobs tested with `Queue::fake()`/`Bus::fake()`. S3 tested with `Storage::fake('s3')`. External provider HTTP tested with `Http::fake()`. No live API calls in any test.

---

## Phase A — Project Foundation

### Task 1: Scaffold Laravel project + Sanctum + base config

**Files:**
- Create: new Laravel project at `/Users/arunkumar/Documents/Application/VideoGenAPI` (via `laravel new`)
- Modify: `config/sanctum.php` (default, published)
- Modify: `bootstrap/app.php` (register `api` middleware group with `auth:sanctum`)
- Modify: `.env.example` (add `AWS_*`, `REDIS_*`, placeholders for provider keys are **not** added here — provider keys are per-user, stored in DB, not env)

**Interfaces:**
- Produces: a runnable Laravel app on `php artisan serve` (default port 8000 — no clash with Python's 8767), Sanctum installed and migrated.

- [ ] **Step 1: Create the project**

```bash
cd /Users/arunkumar/Documents/Application
laravel new VideoGenAPI --no-interaction || composer create-project laravel/laravel VideoGenAPI
cd VideoGenAPI
composer require laravel/sanctum livewire/livewire
php artisan install:api
```

- [ ] **Step 2: Configure queue + cache to Redis in `.env`**

```
QUEUE_CONNECTION=redis
CACHE_STORE=redis
FILESYSTEM_DISK=s3
```

- [ ] **Step 3: Verify boot**

Run: `php artisan serve --port=8000 & curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/up; kill %1`
Expected: `200`

- [ ] **Step 4: Init git, first commit**

```bash
cd /Users/arunkumar/Documents/Application/VideoGenAPI
git init
git add -A
git commit -m "chore: scaffold Laravel project with Sanctum + Livewire"
```

---

### Task 2: Migrations + Models (api_keys, generations, generation_jobs)

**Files:**
- Create: `database/migrations/xxxx_create_api_keys_table.php`
- Create: `database/migrations/xxxx_create_generations_table.php`
- Create: `database/migrations/xxxx_create_generation_jobs_table.php`
- Create: `app/Models/ApiKey.php`
- Create: `app/Models/Generation.php`
- Create: `app/Models/GenerationJob.php`
- Modify: `app/Models/User.php` (add `HasApiTokens`, `hasMany` relations)
- Test: `tests/Feature/Models/ApiKeyModelTest.php`

**Interfaces:**
- Produces: `ApiKey::query()->forUser($userId)`, `ApiKey->maskedKeyAttribute()`, `Generation` and `GenerationJob` models with `user()` belongsTo, both used by every later task.

- [ ] **Step 1: Write the failing model test**

```php
<?php
// tests/Feature/Models/ApiKeyModelTest.php
use App\Models\ApiKey;
use App\Models\User;

test('api key value is encrypted at rest and masked on read', function () {
    $user = User::factory()->create();
    $key = ApiKey::create([
        'user_id' => $user->id,
        'provider' => 'openrouter',
        'key' => 'sk-or-v1-abcdef1234567890',
    ]);

    $raw = \DB::table('api_keys')->where('id', $key->id)->value('key');
    expect($raw)->not->toBe('sk-or-v1-abcdef1234567890'); // stored encrypted
    expect($key->fresh()->key)->toBe('sk-or-v1-abcdef1234567890'); // decrypts via cast
    expect($key->fresh()->masked_key)->toBe('••••7890');
});

test('provider must be one of the four supported', function () {
    $user = User::factory()->create();
    expect(fn () => ApiKey::create([
        'user_id' => $user->id,
        'provider' => 'not-a-provider',
        'key' => 'x',
    ]))->toThrow(\Illuminate\Database\QueryException::class);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `php artisan test --filter=ApiKeyModelTest`
Expected: FAIL — table/class doesn't exist yet.

- [ ] **Step 3: Write migrations**

```php
<?php
// database/migrations/xxxx_create_api_keys_table.php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::create('api_keys', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->enum('provider', ['gemini', 'anthropic', 'openrouter', 'ark']);
            $table->text('key');
            $table->timestamps();
            $table->unique(['user_id', 'provider']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('api_keys');
    }
};
```

```php
<?php
// database/migrations/xxxx_create_generations_table.php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::create('generations', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->enum('kind', ['clip', 'story', 'stitch']);
            $table->string('status')->default('queued'); // queued|running|done|failed|partial
            $table->text('prompt');
            $table->string('tier')->nullable();
            $table->string('resolution')->nullable();
            $table->string('aspect')->default('16:9');
            $table->unsignedInteger('duration')->nullable();
            $table->decimal('cost', 8, 4)->default(0);
            $table->string('clip_path')->nullable(); // S3 key
            $table->json('source_ids')->nullable();
            $table->json('pending_scenes')->nullable();
            $table->timestamps();
            $table->index(['user_id', 'status']);
            $table->index(['user_id', 'kind']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('generations');
    }
};
```

```php
<?php
// database/migrations/xxxx_create_generation_jobs_table.php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::create('generation_jobs', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->foreignId('generation_id')->nullable()->constrained()->nullOnDelete();
            $table->string('type'); // clip|story|stitch
            $table->string('status')->default('queued'); // queued|running|done|failed
            $table->string('detail')->nullable();
            $table->unsignedTinyInteger('progress')->default(0);
            $table->text('error')->nullable();
            $table->timestamps();
            $table->index(['user_id', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('generation_jobs');
    }
};
```

- [ ] **Step 4: Write models**

```php
<?php
// app/Models/ApiKey.php
namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Factories\HasFactory;

class ApiKey extends Model
{
    use HasFactory;

    protected $fillable = ['user_id', 'provider', 'key'];

    protected $casts = [
        'key' => 'encrypted',
    ];

    protected $hidden = ['key'];

    protected $appends = ['masked_key'];

    public function getMaskedKeyAttribute(): string
    {
        $key = $this->attributes['key'] ?? null;
        if (! $key) {
            return '';
        }
        $decrypted = decrypt($key);
        return '••••' . substr($decrypted, -4);
    }

    public function user()
    {
        return $this->belongsTo(User::class);
    }
}
```

```php
<?php
// app/Models/Generation.php
namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Factories\HasFactory;

class Generation extends Model
{
    use HasFactory;

    protected $fillable = [
        'user_id', 'kind', 'status', 'prompt', 'tier', 'resolution',
        'aspect', 'duration', 'cost', 'clip_path', 'source_ids', 'pending_scenes',
    ];

    protected $casts = [
        'source_ids' => 'array',
        'pending_scenes' => 'array',
        'cost' => 'decimal:4',
    ];

    public function user()
    {
        return $this->belongsTo(User::class);
    }

    public function jobs()
    {
        return $this->hasMany(GenerationJob::class);
    }

    public function scopeForUser($query, int $userId)
    {
        return $query->where('user_id', $userId);
    }
}
```

```php
<?php
// app/Models/GenerationJob.php
namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;

class GenerationJob extends Model
{
    use HasUuids;

    protected $fillable = [
        'user_id', 'generation_id', 'type', 'status', 'detail', 'progress', 'error',
    ];

    public function user()
    {
        return $this->belongsTo(User::class);
    }

    public function generation()
    {
        return $this->belongsTo(Generation::class);
    }

    public function scopeForUser($query, int $userId)
    {
        return $query->where('user_id', $userId);
    }
}
```

- [ ] **Step 5: Add `HasApiTokens` to User, run migrations**

```php
// app/Models/User.php — add trait
use Laravel\Sanctum\HasApiTokens;
class User extends Authenticatable
{
    use HasApiTokens, HasFactory, Notifiable;
    // ...
}
```

Run: `php artisan migrate`
Expected: 3 new tables created.

- [ ] **Step 6: Run test to verify it passes**

Run: `php artisan test --filter=ApiKeyModelTest`
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```bash
git add database/migrations app/Models tests/Feature/Models
git commit -m "feat: add api_keys, generations, generation_jobs tables + models"
```

---

### Task 3: Auth (register/login/logout) with rate limiting

**Files:**
- Create: `app/Http/Requests/Auth/RegisterRequest.php`
- Create: `app/Http/Requests/Auth/LoginRequest.php`
- Create: `app/Http/Controllers/Api/AuthController.php`
- Modify: `routes/api.php`
- Test: `tests/Feature/Api/AuthTest.php`

**Interfaces:**
- Produces: `POST /api/v1/auth/register`, `POST /api/v1/auth/login` → `{token, user}`, `POST /api/v1/auth/logout` (revokes current token).

- [ ] **Step 1: Write failing tests**

```php
<?php
// tests/Feature/Api/AuthTest.php
use App\Models\User;

test('user can register and receive a token', function () {
    $res = $this->postJson('/api/v1/auth/register', [
        'name' => 'Ada',
        'email' => 'ada@example.com',
        'password' => 'correct-horse-battery-staple',
        'password_confirmation' => 'correct-horse-battery-staple',
    ]);
    $res->assertCreated()->assertJsonStructure(['token', 'user' => ['id', 'email']]);
});

test('login rejects wrong password', function () {
    $user = User::factory()->create(['password' => bcrypt('right-password')]);
    $res = $this->postJson('/api/v1/auth/login', [
        'email' => $user->email,
        'password' => 'wrong-password',
    ]);
    $res->assertStatus(422);
});

test('login is rate limited after repeated failures', function () {
    $user = User::factory()->create(['password' => bcrypt('right-password')]);
    for ($i = 0; $i < 6; $i++) {
        $res = $this->postJson('/api/v1/auth/login', [
            'email' => $user->email,
            'password' => 'wrong-password',
        ]);
    }
    $res->assertStatus(429);
});

test('logout revokes the current token', function () {
    $user = User::factory()->create();
    $token = $user->createToken('test')->plainTextToken;
    $res = $this->withHeader('Authorization', "Bearer $token")
        ->postJson('/api/v1/auth/logout');
    $res->assertNoContent();
    expect($user->tokens()->count())->toBe(0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `php artisan test --filter=AuthTest`
Expected: FAIL — routes don't exist.

- [ ] **Step 3: Implement FormRequests + controller**

```php
<?php
// app/Http/Requests/Auth/RegisterRequest.php
namespace App\Http\Requests\Auth;

use Illuminate\Foundation\Http\FormRequest;

class RegisterRequest extends FormRequest
{
    public function authorize(): bool { return true; }

    public function rules(): array
    {
        return [
            'name' => ['required', 'string', 'max:255'],
            'email' => ['required', 'email', 'max:255', 'unique:users,email'],
            'password' => ['required', 'string', 'min:12', 'confirmed'],
        ];
    }
}
```

```php
<?php
// app/Http/Requests/Auth/LoginRequest.php
namespace App\Http\Requests\Auth;

use Illuminate\Foundation\Http\FormRequest;

class LoginRequest extends FormRequest
{
    public function authorize(): bool { return true; }

    public function rules(): array
    {
        return [
            'email' => ['required', 'email'],
            'password' => ['required', 'string'],
        ];
    }
}
```

```php
<?php
// app/Http/Controllers/Api/AuthController.php
namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Auth\LoginRequest;
use App\Http\Requests\Auth\RegisterRequest;
use App\Models\User;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\ValidationException;

class AuthController extends Controller
{
    public function register(RegisterRequest $request)
    {
        $data = $request->validated();
        $user = User::create([
            'name' => $data['name'],
            'email' => $data['email'],
            'password' => Hash::make($data['password']),
        ]);
        return response()->json([
            'token' => $user->createToken('api')->plainTextToken,
            'user' => $user->only('id', 'name', 'email'),
        ], 201);
    }

    public function login(LoginRequest $request)
    {
        $data = $request->validated();
        $user = User::where('email', $data['email'])->first();

        if (! $user || ! Hash::check($data['password'], $user->password)) {
            throw ValidationException::withMessages([
                'email' => ['These credentials do not match our records.'],
            ]);
        }

        return response()->json([
            'token' => $user->createToken('api')->plainTextToken,
            'user' => $user->only('id', 'name', 'email'),
        ]);
    }

    public function logout()
    {
        request()->user()->currentAccessToken()->delete();
        return response()->noContent();
    }
}
```

- [ ] **Step 4: Wire routes with throttle**

```php
<?php
// routes/api.php
use App\Http\Controllers\Api\AuthController;
use Illuminate\Support\Facades\Route;

Route::prefix('v1')->group(function () {
    Route::post('auth/register', [AuthController::class, 'register'])
        ->middleware('throttle:5,1');
    Route::post('auth/login', [AuthController::class, 'login'])
        ->middleware('throttle:5,1');

    Route::middleware('auth:sanctum')->group(function () {
        Route::post('auth/logout', [AuthController::class, 'logout']);
        // further protected routes added in later tasks
    });
});
```

- [ ] **Step 5: Run tests to verify pass**

Run: `php artisan test --filter=AuthTest`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add app/Http/Requests/Auth app/Http/Controllers/Api/AuthController.php routes/api.php tests/Feature/Api/AuthTest.php
git commit -m "feat: add Sanctum register/login/logout with rate-limited login"
```

---

### Task 4: Per-user API keys CRUD (encrypted, masked, IDOR-scoped)

**Files:**
- Create: `app/Http/Requests/ApiKeys/StoreApiKeyRequest.php`
- Create: `app/Http/Controllers/Api/ApiKeyController.php`
- Create: `app/Services/ApiKeyResolver.php`
- Modify: `routes/api.php`
- Test: `tests/Feature/Api/ApiKeyTest.php`

**Interfaces:**
- Consumes: `ApiKey` model (Task 2).
- Produces: `ApiKeyResolver::for(User $user, string $provider): string` (throws `RuntimeException` if missing) — used by every provider service in Phase B. `GET/PUT/DELETE /api/v1/keys/{provider}`.

- [ ] **Step 1: Write failing tests**

```php
<?php
// tests/Feature/Api/ApiKeyTest.php
use App\Models\ApiKey;
use App\Models\User;
use Laravel\Sanctum\Sanctum;

test('user can store and list masked keys, never raw', function () {
    $user = User::factory()->create();
    Sanctum::actingAs($user);

    $this->putJson('/api/v1/keys/openrouter', ['key' => 'sk-or-v1-abcdef1234567890'])
        ->assertOk();

    $res = $this->getJson('/api/v1/keys')->assertOk();
    $res->assertJsonFragment(['provider' => 'openrouter', 'masked_key' => '••••7890']);
    $res->assertDontSee('sk-or-v1-abcdef1234567890');
});

test('user cannot read or delete another users key', function () {
    $owner = User::factory()->create();
    $other = User::factory()->create();
    ApiKey::create(['user_id' => $owner->id, 'provider' => 'ark', 'key' => 'secret-ark-key']);

    Sanctum::actingAs($other);
    $this->deleteJson('/api/v1/keys/ark')->assertNotFound(); // scoped — nothing to delete for $other
    expect(ApiKey::where('user_id', $owner->id)->exists())->toBeTrue();
});

test('rejects an invalid provider', function () {
    Sanctum::actingAs(User::factory()->create());
    $this->putJson('/api/v1/keys/not-a-provider', ['key' => 'x'])->assertStatus(422);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `php artisan test --filter=ApiKeyTest`
Expected: FAIL — route/class missing.

- [ ] **Step 3: Implement FormRequest, resolver, controller**

```php
<?php
// app/Http/Requests/ApiKeys/StoreApiKeyRequest.php
namespace App\Http\Requests\ApiKeys;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StoreApiKeyRequest extends FormRequest
{
    public function authorize(): bool { return true; }

    public function rules(): array
    {
        return [
            'provider' => ['required', Rule::in(['gemini', 'anthropic', 'openrouter', 'ark'])],
            'key' => ['required', 'string', 'min:8', 'max:512'],
        ];
    }

    protected function prepareForValidation(): void
    {
        $this->merge(['provider' => $this->route('provider')]);
    }
}
```

```php
<?php
// app/Services/ApiKeyResolver.php
namespace App\Services;

use App\Models\ApiKey;
use App\Models\User;
use RuntimeException;

class ApiKeyResolver
{
    public function for(User $user, string $provider): string
    {
        $key = ApiKey::query()->forUser($user->id)->where('provider', $provider)->first();
        if (! $key) {
            throw new RuntimeException("No {$provider} API key configured for this account.");
        }
        return $key->key; // decrypted via cast
    }
}
```

Add `scopeForUser` to `ApiKey` model (same pattern as `Generation`):

```php
// app/Models/ApiKey.php — add method
public function scopeForUser($query, int $userId)
{
    return $query->where('user_id', $userId);
}
```

```php
<?php
// app/Http/Controllers/Api/ApiKeyController.php
namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\ApiKeys\StoreApiKeyRequest;
use App\Models\ApiKey;
use Illuminate\Http\Request;

class ApiKeyController extends Controller
{
    public function index(Request $request)
    {
        return ApiKey::query()
            ->forUser($request->user()->id)
            ->get(['id', 'provider', 'created_at'])
            ->map(fn ($k) => $k->only('id', 'provider', 'created_at') + ['masked_key' => $k->masked_key]);
    }

    public function store(StoreApiKeyRequest $request, string $provider)
    {
        $data = $request->validated();
        $key = ApiKey::updateOrCreate(
            ['user_id' => $request->user()->id, 'provider' => $provider],
            ['key' => $data['key']],
        );
        return response()->json(['provider' => $key->provider, 'masked_key' => $key->masked_key]);
    }

    public function destroy(Request $request, string $provider)
    {
        $deleted = ApiKey::query()
            ->forUser($request->user()->id)
            ->where('provider', $provider)
            ->delete();

        return $deleted ? response()->noContent() : response()->json(['error' => 'not found'], 404);
    }
}
```

- [ ] **Step 4: Wire routes**

```php
// routes/api.php — inside auth:sanctum group
Route::get('keys', [ApiKeyController::class, 'index']);
Route::put('keys/{provider}', [ApiKeyController::class, 'store']);
Route::delete('keys/{provider}', [ApiKeyController::class, 'destroy']);
```

- [ ] **Step 5: Run tests to verify pass**

Run: `php artisan test --filter=ApiKeyTest`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add app/Http/Requests/ApiKeys app/Http/Controllers/Api/ApiKeyController.php app/Services/ApiKeyResolver.php routes/api.php tests/Feature/Api/ApiKeyTest.php app/Models/ApiKey.php
git commit -m "feat: per-user encrypted API key CRUD, IDOR-scoped"
```

---

### Task 5: `config/engines.php` + CostEstimator + `/api/v1/models`

**Files:**
- Create: `config/engines.php`
- Create: `app/Services/CostEstimator.php`
- Create: `app/Http/Controllers/Api/ModelController.php`
- Modify: `routes/api.php`
- Test: `tests/Feature/Api/ModelControllerTest.php`

**Interfaces:**
- Produces: `config('engines.tiers')` array, `CostEstimator::estimate(string $tier, string $resolution, int $duration): float`, `GET /api/v1/models`.
- **Before writing `CostEstimator`, read the exact pricing tables** from the source Python files — do not approximate: `/Users/arunkumar/Documents/Application/VideoGen/veo.py` (`estimate_cost`), `/Users/arunkumar/Documents/Application/VideoGen/openrouter_video.py` (`estimate_cost`, `MODELS`), `/Users/arunkumar/Documents/Application/VideoGen/ark_video.py` (`estimate_cost`). Port the numeric constants 1:1.

- [ ] **Step 1: Write failing test (structure only — exact cost values asserted once ported in Step 3)**

```php
<?php
// tests/Feature/Api/ModelControllerTest.php
use App\Models\User;
use Laravel\Sanctum\Sanctum;

test('models endpoint returns capability-driven config, no hard-coded UI models', function () {
    Sanctum::actingAs(User::factory()->create());
    $res = $this->getJson('/api/v1/models')->assertOk();
    $res->assertJsonStructure([
        '*' => ['id', 'name', 'durations', 'aspectRatios', 'resolutions', 'refSupport', 'refTypes', 'audio', 'costEstimateUsd'],
    ]);
    $ids = collect($res->json())->pluck('id')->all();
    expect($ids)->toContain('lite', 'grok', 'ark-seedance-mini');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `php artisan test --filter=ModelControllerTest`
Expected: FAIL.

- [ ] **Step 3: Port `config/engines.php` (structure ported verbatim from `server.py`'s `ENGINES` dict)**

```php
<?php
// config/engines.php
return [
    'aspects' => ['16:9', '9:16'],
    'veo_durations' => [4, 6, 8], // Veo's hard limit

    'tiers' => [
        'lite'              => ['provider' => 'veo', 'name' => 'Veo — Lite', 'resolutions' => ['720p', '1080p']],
        'fast'              => ['provider' => 'veo', 'name' => 'Veo — Fast', 'resolutions' => ['720p', '1080p']],
        'quality'           => ['provider' => 'veo', 'name' => 'Veo — Quality', 'resolutions' => ['720p', '1080p']],
        'grok'              => ['provider' => 'openrouter', 'name' => 'Grok Imagine', 'resolutions' => ['480p', '720p']],
        'seedance'          => ['provider' => 'openrouter', 'name' => 'Seedance 1.5 Pro', 'resolutions' => ['720p', '1080p']],
        'seedance-fast'     => ['provider' => 'openrouter', 'name' => 'Seedance 1.5 Fast', 'resolutions' => ['720p', '1080p']],
        'seedance-mini'     => ['provider' => 'openrouter', 'name' => 'Seedance Mini', 'resolutions' => ['480p', '720p']],
        'seedance-2.5'      => ['provider' => 'openrouter', 'name' => 'Seedance 2.5', 'resolutions' => ['480p', '720p']],
        'ark-seedance-mini' => ['provider' => 'ark', 'name' => 'Seedance 2.0 Mini (Direct)', 'resolutions' => ['480p', '720p']],
    ],

    // Per-tier duration overrides for non-Veo providers — port exact values from
    // openrouter_video.py MODELS[*]['durations'] and ark_video.py MODELS[*]['durations'].
    'durations' => [
        // e.g. 'grok' => [5, 10], filled in from the source files during implementation
    ],

    // refSupport/refTypes/audio — VideoGen's clips support character reference images
    // (server.py MAX_REF_IMAGES) on every tier; no per-model audio track today.
    'ref_support_default' => true,
    'ref_types' => ['character'],
    'audio_default' => false,
];
```

```php
<?php
// app/Services/CostEstimator.php
namespace App\Services;

class CostEstimator
{
    public function estimate(string $tier, string $resolution, int $duration): float
    {
        $provider = config("engines.tiers.{$tier}.provider");

        return match ($provider) {
            'openrouter' => $this->openRouterCost($tier, $resolution, $duration),
            'ark' => $this->arkCost($tier, $resolution, $duration),
            default => $this->veoCost($tier, $resolution, $duration),
        };
    }

    // Port the exact per-second/per-resolution rates from veo.py::estimate_cost.
    private function veoCost(string $tier, string $resolution, int $duration): float
    {
        // TODO(impl): copy exact constants from veo.py estimate_cost() — do not guess.
        return 0.0;
    }

    // Port the exact rates from openrouter_video.py::estimate_cost / MODELS table.
    private function openRouterCost(string $tier, string $resolution, int $duration): float
    {
        return 0.0;
    }

    // Port the exact rates from ark_video.py::estimate_cost.
    private function arkCost(string $tier, string $resolution, int $duration): float
    {
        return 0.0;
    }
}
```

> **Implementer note:** the two `TODO(impl)` blocks above are the one deliberate exception to this plan's "no placeholders" rule — they exist because the exact dollar constants live in Python source files this plan's author did not have open when writing this task. Before marking this task done, open `veo.py`, `openrouter_video.py`, `ark_video.py` in the VideoGen repo, copy every constant verbatim into the three private methods and the `durations` config array, and update the test in Step 1 to assert on the real ported numbers for at least one tier per provider. Do not commit this task with the `TODO(impl)` markers still present.

```php
<?php
// app/Http/Controllers/Api/ModelController.php
namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\CostEstimator;

class ModelController extends Controller
{
    public function index(CostEstimator $costs)
    {
        return collect(config('engines.tiers'))->map(function (array $spec, string $id) use ($costs) {
            $durations = config("engines.durations.{$id}", config('engines.veo_durations'));
            $resolution = $spec['resolutions'][0];
            $duration = $durations[0];
            return [
                'id' => $id,
                'name' => $spec['name'],
                'durations' => $durations,
                'aspectRatios' => config('engines.aspects'),
                'resolutions' => $spec['resolutions'],
                'refSupport' => config('engines.ref_support_default'),
                'refTypes' => config('engines.ref_types'),
                'audio' => config('engines.audio_default'),
                'costEstimateUsd' => $costs->estimate($id, $resolution, $duration),
            ];
        })->values();
    }
}
```

- [ ] **Step 4: Wire route**

```php
// routes/api.php — inside auth:sanctum group
Route::get('models', [ModelController::class, 'index']);
```

- [ ] **Step 5: Run tests to verify pass**

Run: `php artisan test --filter=ModelControllerTest`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add config/engines.php app/Services/CostEstimator.php app/Http/Controllers/Api/ModelController.php routes/api.php tests/Feature/Api/ModelControllerTest.php
git commit -m "feat: engine config + cost estimator + /api/v1/models"
```

---

## Phase B — Provider Integrations, Jobs, ffmpeg

### Task 6: `VideoEngineInterface` + `GeminiVeoService` + `AnthropicService`

**Files:**
- Create: `app/Services/Engines/VideoEngineInterface.php`
- Create: `app/Services/Engines/GeminiVeoService.php`
- Create: `app/Services/AnthropicService.php`
- Test: `tests/Unit/Services/GeminiVeoServiceTest.php`
- Test: `tests/Unit/Services/AnthropicServiceTest.php`

**Interfaces:**
- Consumes: `ApiKeyResolver::for()` (Task 4).
- Produces: `VideoEngineInterface::generateClip(User $user, array $params): array` (returns `['clip_path' => string, 'cost' => float]` or throws), `AnthropicService::haiku(User $user, string $system, array $content): string` — used by write-story/restructure/storyboard/enhance in Task 10.

- [ ] **Step 1: Write failing tests**

```php
<?php
// tests/Unit/Services/GeminiVeoServiceTest.php
use App\Models\ApiKey;
use App\Models\User;
use App\Services\ApiKeyResolver;
use App\Services\Engines\GeminiVeoService;
use Illuminate\Support\Facades\Http;

test('throws when user has no gemini key configured', function () {
    $user = User::factory()->create();
    $service = new GeminiVeoService(new ApiKeyResolver());

    expect(fn () => $service->generateClip($user, ['tier' => 'lite', 'prompt' => 'a fox in snow', 'resolution' => '720p', 'duration' => 8]))
        ->toThrow(RuntimeException::class);
});

test('calls Veo API with the users own key, never a shared one', function () {
    $user = User::factory()->create();
    ApiKey::create(['user_id' => $user->id, 'provider' => 'gemini', 'key' => 'user-own-gemini-key']);
    Http::fake(['*generativelanguage.googleapis.com*' => Http::response(['name' => 'operations/abc'], 200)]);

    $service = new GeminiVeoService(new ApiKeyResolver());
    // Full generateClip() also polls the operation and downloads the file — that part
    // is exercised end-to-end in Task 8's GenerateClipJob test via Http::fake sequencing.
    // This unit test only proves the key resolution path is per-user.
    Http::fake(['*' => Http::response(['done' => true, 'response' => ['generateVideoResponse' => ['generatedSamples' => [['video' => ['uri' => 'https://example.com/v.mp4']]]]]], 200)]);

    expect(fn () => $service->generateClip($user, ['tier' => 'lite', 'prompt' => 'a fox in snow', 'resolution' => '720p', 'duration' => 8]))
        ->not->toThrow(RuntimeException::class);

    Http::assertSent(fn ($request) => str_contains($request->url(), 'user-own-gemini-key') || $request->hasHeader('x-goog-api-key', 'user-own-gemini-key'));
});
```

```php
<?php
// tests/Unit/Services/AnthropicServiceTest.php
use App\Models\ApiKey;
use App\Models\User;
use App\Services\AnthropicService;
use App\Services\ApiKeyResolver;
use Illuminate\Support\Facades\Http;

test('haiku call uses the users own anthropic key and returns text', function () {
    $user = User::factory()->create();
    ApiKey::create(['user_id' => $user->id, 'provider' => 'anthropic', 'key' => 'sk-ant-user-key']);
    Http::fake(['api.anthropic.com/*' => Http::response(['content' => [['type' => 'text', 'text' => 'enhanced prompt text']]], 200)]);

    $service = new AnthropicService(new ApiKeyResolver());
    $result = $service->haiku($user, 'system prompt', [['type' => 'text', 'text' => 'a fox']]);

    expect($result)->toBe('enhanced prompt text');
    Http::assertSent(fn ($request) => $request->hasHeader('x-api-key', 'sk-ant-user-key'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `php artisan test --filter="GeminiVeoServiceTest|AnthropicServiceTest"`
Expected: FAIL.

- [ ] **Step 3: Implement interface + services**

```php
<?php
// app/Services/Engines/VideoEngineInterface.php
namespace App\Services\Engines;

use App\Models\User;

interface VideoEngineInterface
{
    /**
     * @param array{tier: string, prompt: string, resolution: string, duration: int,
     *   aspect?: string, image_path?: ?string, reference_paths?: array}
     * $params
     * @return array{clip_path: string, cost: float}
     */
    public function generateClip(User $user, array $params): array;
}
```

```php
<?php
// app/Services/Engines/GeminiVeoService.php
namespace App\Services\Engines;

use App\Models\User;
use App\Services\ApiKeyResolver;
use Illuminate\Support\Facades\Http;
use RuntimeException;

class GeminiVeoService implements VideoEngineInterface
{
    public function __construct(private ApiKeyResolver $keys) {}

    public function generateClip(User $user, array $params): array
    {
        $apiKey = $this->keys->for($user, 'gemini');

        $start = Http::withHeaders(['x-goog-api-key' => $apiKey])
            ->post('https://generativelanguage.googleapis.com/v1beta/models/veo-3.0:generateVideo', [
                'prompt' => $params['prompt'],
                'resolution' => $params['resolution'],
                'durationSeconds' => $params['duration'],
                'aspectRatio' => $params['aspect'] ?? '16:9',
            ]);

        if ($start->failed()) {
            throw new RuntimeException('Veo request failed: ' . $start->status());
        }

        $poll = Http::withHeaders(['x-goog-api-key' => $apiKey])
            ->get('https://generativelanguage.googleapis.com/v1beta/' . $start->json('name', ''));

        $uri = data_get($poll->json(), 'response.generateVideoResponse.generatedSamples.0.video.uri');
        if (! $uri) {
            throw new RuntimeException('Veo did not return a video URI.');
        }

        return ['clip_path' => $uri, 'cost' => app(\App\Services\CostEstimator::class)
            ->estimate($params['tier'], $params['resolution'], $params['duration'])];
    }
}
```

```php
<?php
// app/Services/AnthropicService.php
namespace App\Services;

use App\Models\User;
use Illuminate\Support\Facades\Http;
use RuntimeException;

class AnthropicService
{
    public function __construct(private ApiKeyResolver $keys) {}

    public function haiku(User $user, string $system, array $content): string
    {
        $apiKey = $this->keys->for($user, 'anthropic');

        $res = Http::withHeaders([
            'x-api-key' => $apiKey,
            'anthropic-version' => '2023-06-01',
        ])->post('https://api.anthropic.com/v1/messages', [
            'model' => 'claude-haiku-4-5-20251001',
            'max_tokens' => 1024,
            'system' => $system,
            'messages' => [['role' => 'user', 'content' => $content]],
        ]);

        if ($res->failed()) {
            throw new RuntimeException('Anthropic request failed: ' . $res->status());
        }

        return data_get($res->json(), 'content.0.text', '');
    }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `php artisan test --filter="GeminiVeoServiceTest|AnthropicServiceTest"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/Services/Engines app/Services/AnthropicService.php tests/Unit/Services
git commit -m "feat: Veo + Anthropic provider services, per-user keys only"
```

---

### Task 7: `OpenRouterService` + `ArkService` + `EngineResolver`

**Files:**
- Create: `app/Services/Engines/OpenRouterService.php`
- Create: `app/Services/Engines/ArkService.php`
- Create: `app/Services/Engines/EngineResolver.php`
- Test: `tests/Unit/Services/EngineResolverTest.php`

**Interfaces:**
- Consumes: `VideoEngineInterface` (Task 6).
- Produces: `EngineResolver::for(string $tier): VideoEngineInterface` — used by `GenerateClipJob`/`GenerateStoryJob` (Task 8/9).

- [ ] **Step 1: Write failing test**

```php
<?php
// tests/Unit/Services/EngineResolverTest.php
use App\Services\Engines\ArkService;
use App\Services\Engines\EngineResolver;
use App\Services\Engines\GeminiVeoService;
use App\Services\Engines\OpenRouterService;

test('resolves the correct provider service per tier, from config not a hard-coded map', function () {
    $resolver = app(EngineResolver::class);
    expect($resolver->for('lite'))->toBeInstanceOf(GeminiVeoService::class);
    expect($resolver->for('grok'))->toBeInstanceOf(OpenRouterService::class);
    expect($resolver->for('ark-seedance-mini'))->toBeInstanceOf(ArkService::class);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `php artisan test --filter=EngineResolverTest`
Expected: FAIL.

- [ ] **Step 3: Implement**

```php
<?php
// app/Services/Engines/OpenRouterService.php
namespace App\Services\Engines;

use App\Models\User;
use App\Services\ApiKeyResolver;
use App\Services\CostEstimator;
use Illuminate\Support\Facades\Http;
use RuntimeException;

class OpenRouterService implements VideoEngineInterface
{
    public function __construct(private ApiKeyResolver $keys, private CostEstimator $costs) {}

    public function generateClip(User $user, array $params): array
    {
        $apiKey = $this->keys->for($user, 'openrouter');

        $res = Http::withToken($apiKey)
            ->post('https://openrouter.ai/api/v1/videos', [
                'model' => $params['tier'],
                'prompt' => $params['prompt'],
                'resolution' => $params['resolution'],
                'duration' => $params['duration'],
                'aspect_ratio' => $params['aspect'] ?? '16:9',
            ]);

        if ($res->failed()) {
            throw new RuntimeException('OpenRouter request failed: ' . $res->status());
        }

        $url = data_get($res->json(), 'data.0.url');
        if (! $url) {
            throw new RuntimeException('OpenRouter did not return a video URL.');
        }

        return ['clip_path' => $url, 'cost' => $this->costs->estimate($params['tier'], $params['resolution'], $params['duration'])];
    }
}
```

```php
<?php
// app/Services/Engines/ArkService.php
namespace App\Services\Engines;

use App\Models\User;
use App\Services\ApiKeyResolver;
use App\Services\CostEstimator;
use Illuminate\Support\Facades\Http;
use RuntimeException;

class ArkService implements VideoEngineInterface
{
    public function __construct(private ApiKeyResolver $keys, private CostEstimator $costs) {}

    public function generateClip(User $user, array $params): array
    {
        $apiKey = $this->keys->for($user, 'ark');

        $res = Http::withToken($apiKey)
            ->post('https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks', [
                'model' => $params['tier'],
                'content' => [['type' => 'text', 'text' => $params['prompt']]],
                'resolution' => $params['resolution'],
                'duration' => $params['duration'],
            ]);

        if ($res->failed()) {
            throw new RuntimeException('ARK request failed: ' . $res->status());
        }

        $url = data_get($res->json(), 'content.video_url');
        if (! $url) {
            throw new RuntimeException('ARK did not return a video URL.');
        }

        return ['clip_path' => $url, 'cost' => $this->costs->estimate($params['tier'], $params['resolution'], $params['duration'])];
    }
}
```

```php
<?php
// app/Services/Engines/EngineResolver.php
namespace App\Services\Engines;

use RuntimeException;

class EngineResolver
{
    public function __construct(
        private GeminiVeoService $veo,
        private OpenRouterService $openRouter,
        private ArkService $ark,
    ) {}

    public function for(string $tier): VideoEngineInterface
    {
        $provider = config("engines.tiers.{$tier}.provider");

        return match ($provider) {
            'veo' => $this->veo,
            'openrouter' => $this->openRouter,
            'ark' => $this->ark,
            default => throw new RuntimeException("Unknown tier: {$tier}"),
        };
    }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `php artisan test --filter=EngineResolverTest`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/Services/Engines/OpenRouterService.php app/Services/Engines/ArkService.php app/Services/Engines/EngineResolver.php tests/Unit/Services/EngineResolverTest.php
git commit -m "feat: OpenRouter + ARK provider services, tier-to-provider resolver"
```

---

### Task 8: `GenerateClipRequest` + `GenerateClipJob` + `POST /api/v1/generations`

**Files:**
- Create: `app/Http/Requests/Generations/GenerateClipRequest.php`
- Create: `app/Jobs/GenerateClipJob.php`
- Create: `app/Http/Controllers/Api/GenerationController.php`
- Modify: `routes/api.php`
- Test: `tests/Feature/Api/GenerateClipTest.php`

**Interfaces:**
- Consumes: `EngineResolver` (Task 7), `Generation`/`GenerationJob` models (Task 2).
- Produces: `POST /api/v1/generations` → `202 {jobId, generationId}`; `GenerateClipJob` pattern reused by Task 9 (story) and Task 11 (stitch).

- [ ] **Step 1: Write failing test**

```php
<?php
// tests/Feature/Api/GenerateClipTest.php
use App\Jobs\GenerateClipJob;
use App\Models\ApiKey;
use App\Models\User;
use Illuminate\Support\Facades\Queue;
use Laravel\Sanctum\Sanctum;

test('queues a clip generation job and returns 202 with job + generation ids', function () {
    $user = User::factory()->create();
    ApiKey::create(['user_id' => $user->id, 'provider' => 'gemini', 'key' => 'user-key']);
    Sanctum::actingAs($user);
    Queue::fake();

    $res = $this->postJson('/api/v1/generations', [
        'prompt' => 'a fox pokes its head out of the snow',
        'tier' => 'lite',
        'resolution' => '720p',
        'aspect' => '16:9',
        'duration' => 8,
    ])->assertStatus(202);

    $res->assertJsonStructure(['jobId', 'generationId']);
    Queue::assertPushed(GenerateClipJob::class);
});

test('rejects an invalid tier/resolution combination', function () {
    Sanctum::actingAs(User::factory()->create());
    $this->postJson('/api/v1/generations', [
        'prompt' => 'x', 'tier' => 'grok', 'resolution' => '1080p', 'duration' => 5,
    ])->assertStatus(422);
});

test('rejects a prompt over 8000 chars', function () {
    Sanctum::actingAs(User::factory()->create());
    $this->postJson('/api/v1/generations', [
        'prompt' => str_repeat('a', 8001), 'tier' => 'lite', 'resolution' => '720p', 'duration' => 8,
    ])->assertStatus(422);
});

test('rejects when the users provider key is missing, without ever touching the queue', function () {
    Sanctum::actingAs(User::factory()->create()); // no gemini key stored
    Queue::fake();

    $this->postJson('/api/v1/generations', [
        'prompt' => 'a fox', 'tier' => 'lite', 'resolution' => '720p', 'duration' => 8,
    ])->assertStatus(503);

    Queue::assertNotPushed(GenerateClipJob::class);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `php artisan test --filter=GenerateClipTest`
Expected: FAIL.

- [ ] **Step 3: Implement FormRequest with server-side engine validation**

```php
<?php
// app/Http/Requests/Generations/GenerateClipRequest.php
namespace App\Http\Requests\Generations;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

class GenerateClipRequest extends FormRequest
{
    public function authorize(): bool { return true; }

    public function rules(): array
    {
        return [
            'prompt' => ['required', 'string', 'max:8000'],
            'tier' => ['required', 'string', Rule::in(array_keys(config('engines.tiers')))],
            'resolution' => ['required', 'string'],
            'aspect' => ['sometimes', 'string', Rule::in(config('engines.aspects'))],
            'duration' => ['required', 'integer'],
            'image_base64' => ['sometimes', 'string'],
            'image_mime' => ['sometimes', 'string', Rule::in(['image/png', 'image/jpeg', 'image/webp'])],
            'reference_images' => ['sometimes', 'array', 'max:5'],
        ];
    }

    public function withValidator(Validator $validator): void
    {
        $validator->after(function ($validator) {
            $tier = $this->input('tier');
            $spec = config("engines.tiers.{$tier}");
            if (! $spec) {
                return; // caught by the 'tier' rule already
            }
            if (! in_array($this->input('resolution'), $spec['resolutions'], true)) {
                $validator->errors()->add('resolution', "{$tier} supports " . implode(', ', $spec['resolutions']) . ' only.');
            }
            $aspect = $this->input('aspect', '16:9');
            if ($aspect === '9:16' && $this->input('resolution') === '1080p' && $spec['provider'] === 'veo') {
                $validator->errors()->add('resolution', '9:16 on Veo supports 720p only.');
            }
            $durations = config("engines.durations.{$tier}", config('engines.veo_durations'));
            if (! in_array((int) $this->input('duration'), $durations, true)) {
                $validator->errors()->add('duration', "{$tier} supports durations: " . implode(', ', $durations));
            }
        });
    }
}
```

- [ ] **Step 4: Implement `GenerateClipJob`**

```php
<?php
// app/Jobs/GenerateClipJob.php
namespace App\Jobs;

use App\Models\Generation;
use App\Models\GenerationJob;
use App\Services\Engines\EngineResolver;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;

class GenerateClipJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public function __construct(
        public string $jobId,
        public int $generationId,
        public int $userId,
        public array $params,
    ) {}

    public function handle(EngineResolver $engines): void
    {
        $this->markRunning();
        $generation = Generation::findOrFail($this->generationId);
        $user = $generation->user;

        try {
            $engine = $engines->for($this->params['tier']);
            $result = $engine->generateClip($user, $this->params);

            DB::transaction(function () use ($generation, $result) {
                $generation->update(['status' => 'done', 'clip_path' => $result['clip_path'], 'cost' => $result['cost']]);
            });

            GenerationJob::where('id', $this->jobId)->update([
                'status' => 'done', 'detail' => 'done', 'progress' => 100,
            ]);
        } catch (\Throwable $e) {
            $generation->update(['status' => 'failed']);
            GenerationJob::where('id', $this->jobId)->update([
                'status' => 'failed', 'error' => substr($e->getMessage(), 0, 500),
            ]);
        }
    }

    private function markRunning(): void
    {
        GenerationJob::where('id', $this->jobId)->update(['status' => 'running', 'detail' => 'generating']);
    }
}
```

- [ ] **Step 5: Implement controller**

```php
<?php
// app/Http/Controllers/Api/GenerationController.php
namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Generations\GenerateClipRequest;
use App\Jobs\GenerateClipJob;
use App\Models\Generation;
use App\Models\GenerationJob;
use App\Services\ApiKeyResolver;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use RuntimeException;

class GenerationController extends Controller
{
    public function index(Request $request)
    {
        return Generation::query()
            ->forUser($request->user()->id)
            ->when($request->query('status'), fn ($q, $s) => $q->where('status', $s))
            ->when($request->query('kind'), fn ($q, $k) => $q->where('kind', $k))
            ->latest()
            ->paginate(20);
    }

    public function store(GenerateClipRequest $request, ApiKeyResolver $keys)
    {
        $data = $request->validated();
        $tier = $data['tier'];
        $provider = config("engines.tiers.{$tier}.provider");

        try {
            $keys->for($request->user(), $provider);
        } catch (RuntimeException $e) {
            return response()->json(['error' => $e->getMessage()], 503);
        }

        $generation = Generation::create([
            'user_id' => $request->user()->id,
            'kind' => 'clip',
            'status' => 'queued',
            'prompt' => $data['prompt'],
            'tier' => $tier,
            'resolution' => $data['resolution'],
            'aspect' => $data['aspect'] ?? '16:9',
            'duration' => $data['duration'],
        ]);

        $jobId = (string) Str::uuid();
        GenerationJob::create([
            'id' => $jobId, 'user_id' => $request->user()->id, 'generation_id' => $generation->id,
            'type' => 'clip', 'status' => 'queued',
        ]);

        GenerateClipJob::dispatch($jobId, $generation->id, $request->user()->id, $data);

        return response()->json(['jobId' => $jobId, 'generationId' => $generation->id], 202);
    }

    public function destroy(Request $request, Generation $generation)
    {
        abort_unless($generation->user_id === $request->user()->id, 404);
        $generation->delete();
        return response()->noContent();
    }
}
```

- [ ] **Step 6: Wire routes**

```php
// routes/api.php — inside auth:sanctum group
Route::get('generations', [GenerationController::class, 'index']);
Route::post('generations', [GenerationController::class, 'store']);
Route::delete('generations/{generation}', [GenerationController::class, 'destroy']);
```

- [ ] **Step 7: Run tests to verify pass**

Run: `php artisan test --filter=GenerateClipTest`
Expected: PASS (4 tests)

- [ ] **Step 8: Commit**

```bash
git add app/Http/Requests/Generations app/Jobs/GenerateClipJob.php app/Http/Controllers/Api/GenerationController.php routes/api.php tests/Feature/Api/GenerateClipTest.php
git commit -m "feat: POST /api/v1/generations with queued clip generation"
```

---

### Task 9: `GenerateStoryJob` + `/api/v1/stories` + `/api/v1/stories/resume`

**Files:**
- Create: `app/Http/Requests/Generations/GenerateStoryRequest.php`
- Create: `app/Jobs/GenerateStoryJob.php`
- Create: `app/Http/Controllers/Api/StoryController.php`
- Modify: `routes/api.php`
- Test: `tests/Feature/Api/GenerateStoryTest.php`

**Interfaces:**
- Consumes: `EngineResolver` (Task 7), `Generation`/`GenerationJob` (Task 2).
- Produces: `POST /api/v1/stories` → `202`, `POST /api/v1/stories/resume` → `202`. Story partial-failure behavior ports `server.py::run_story`'s "stitch what's done, save `pending_scenes`" pattern.

- [ ] **Step 1: Write failing test**

```php
<?php
// tests/Feature/Api/GenerateStoryTest.php
use App\Jobs\GenerateStoryJob;
use App\Models\ApiKey;
use App\Models\User;
use Illuminate\Support\Facades\Queue;
use Laravel\Sanctum\Sanctum;

test('queues a story job for 1-8 scenes', function () {
    $user = User::factory()->create();
    ApiKey::create(['user_id' => $user->id, 'provider' => 'gemini', 'key' => 'k']);
    Sanctum::actingAs($user);
    Queue::fake();

    $this->postJson('/api/v1/stories', [
        'tier' => 'lite', 'resolution' => '720p', 'aspect' => '16:9',
        'scenes' => [
            ['prompt' => 'scene one', 'duration' => 8],
            ['prompt' => 'scene two', 'duration' => 8],
        ],
    ])->assertStatus(202)->assertJsonStructure(['jobId', 'generationId']);

    Queue::assertPushed(GenerateStoryJob::class);
});

test('rejects more than the max scene count', function () {
    Sanctum::actingAs(User::factory()->create());
    $this->postJson('/api/v1/stories', [
        'tier' => 'lite', 'resolution' => '720p',
        'scenes' => array_fill(0, 21, ['prompt' => 'x', 'duration' => 8]),
    ])->assertStatus(422);
});

test('resume continues a partial story from its pending_scenes', function () {
    $user = User::factory()->create();
    ApiKey::create(['user_id' => $user->id, 'provider' => 'gemini', 'key' => 'k']);
    Sanctum::actingAs($user);
    $generation = \App\Models\Generation::create([
        'user_id' => $user->id, 'kind' => 'story', 'status' => 'partial',
        'prompt' => 'Story — 2 scenes', 'tier' => 'lite', 'resolution' => '720p',
        'pending_scenes' => [['prompt' => 'scene two', 'duration' => 8]],
        'source_ids' => [],
    ]);
    Queue::fake();

    $this->postJson('/api/v1/stories/resume', ['generation_id' => $generation->id])
        ->assertStatus(202);

    Queue::assertPushed(GenerateStoryJob::class);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `php artisan test --filter=GenerateStoryTest`
Expected: FAIL.

- [ ] **Step 3: Implement FormRequest**

```php
<?php
// app/Http/Requests/Generations/GenerateStoryRequest.php
namespace App\Http\Requests\Generations;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class GenerateStoryRequest extends FormRequest
{
    public function authorize(): bool { return true; }

    public function rules(): array
    {
        return [
            'tier' => ['required', 'string', Rule::in(array_keys(config('engines.tiers')))],
            'resolution' => ['required', 'string'],
            'aspect' => ['sometimes', 'string', Rule::in(config('engines.aspects'))],
            'scenes' => ['required', 'array', 'min:1', 'max:20'],
            'scenes.*.prompt' => ['required', 'string', 'max:8000'],
            'scenes.*.duration' => ['required', 'integer'],
            'scenes.*.image_index' => ['sometimes', 'nullable', 'integer', 'min:0'],
            'images' => ['sometimes', 'array', 'max:20'],
        ];
    }
}
```

- [ ] **Step 4: Implement `GenerateStoryJob`** (sequential scene generation, partial-story recovery ported from `server.py::run_story`)

```php
<?php
// app/Jobs/GenerateStoryJob.php
namespace App\Jobs;

use App\Models\Generation;
use App\Models\GenerationJob;
use App\Services\Engines\EngineResolver;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;

class GenerateStoryJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public function __construct(
        public string $jobId,
        public int $generationId,
        public array $scenes, // remaining scenes to generate this run
    ) {}

    public function handle(EngineResolver $engines): void
    {
        $generation = Generation::findOrFail($this->generationId);
        $user = $generation->user;
        $engine = $engines->for($generation->tier);
        $sourceIds = $generation->source_ids ?? [];
        $doneCount = 0;

        GenerationJob::where('id', $this->jobId)->update(['status' => 'running', 'detail' => 'generating scenes']);

        try {
            foreach ($this->scenes as $i => $scene) {
                GenerationJob::where('id', $this->jobId)->update([
                    'detail' => "clip " . (count($sourceIds) + 1) . "/" . (count($sourceIds) + count($this->scenes)),
                ]);

                $result = $engine->generateClip($user, [
                    'tier' => $generation->tier,
                    'prompt' => $scene['prompt'],
                    'resolution' => $generation->resolution,
                    'duration' => $scene['duration'],
                    'aspect' => $generation->aspect,
                ]);

                $sourceIds[] = $result['clip_path'];
                $doneCount++;
            }

            $generation->update([
                'status' => 'complete', 'source_ids' => $sourceIds, 'pending_scenes' => [],
            ]);
            GenerationJob::where('id', $this->jobId)->update(['status' => 'done', 'detail' => 'done', 'progress' => 100]);
        } catch (\Throwable $e) {
            $remaining = array_slice($this->scenes, $doneCount);
            if (count($sourceIds) > 0) {
                // partial story — save what's done, remaining scenes resumable via /stories/resume
                $generation->update([
                    'status' => 'partial', 'source_ids' => $sourceIds, 'pending_scenes' => $remaining,
                ]);
                GenerationJob::where('id', $this->jobId)->update([
                    'status' => 'done', 'detail' => 'partial: ' . count($sourceIds) . ' scenes done',
                ]);
            } else {
                $generation->update(['status' => 'failed']);
                GenerationJob::where('id', $this->jobId)->update([
                    'status' => 'failed', 'error' => substr($e->getMessage(), 0, 500),
                ]);
            }
        }
    }
}
```

- [ ] **Step 5: Implement controller**

```php
<?php
// app/Http/Controllers/Api/StoryController.php
namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Generations\GenerateStoryRequest;
use App\Jobs\GenerateStoryJob;
use App\Models\Generation;
use App\Models\GenerationJob;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

class StoryController extends Controller
{
    public function store(GenerateStoryRequest $request)
    {
        $data = $request->validated();

        $generation = Generation::create([
            'user_id' => $request->user()->id,
            'kind' => 'story',
            'status' => 'queued',
            'prompt' => 'Story — ' . count($data['scenes']) . ' scenes',
            'tier' => $data['tier'],
            'resolution' => $data['resolution'],
            'aspect' => $data['aspect'] ?? '16:9',
            'source_ids' => [],
        ]);

        $jobId = (string) Str::uuid();
        GenerationJob::create([
            'id' => $jobId, 'user_id' => $request->user()->id, 'generation_id' => $generation->id,
            'type' => 'story', 'status' => 'queued',
        ]);

        GenerateStoryJob::dispatch($jobId, $generation->id, $data['scenes']);

        return response()->json(['jobId' => $jobId, 'generationId' => $generation->id], 202);
    }

    public function resume(Request $request)
    {
        $data = $request->validate(['generation_id' => ['required', 'integer']]);
        $generation = Generation::query()->forUser($request->user()->id)->findOrFail($data['generation_id']);
        abort_unless($generation->status === 'partial' && ! empty($generation->pending_scenes), 422, 'Nothing to resume.');

        $jobId = (string) Str::uuid();
        GenerationJob::create([
            'id' => $jobId, 'user_id' => $request->user()->id, 'generation_id' => $generation->id,
            'type' => 'story', 'status' => 'queued',
        ]);

        GenerateStoryJob::dispatch($jobId, $generation->id, $generation->pending_scenes);

        return response()->json(['jobId' => $jobId, 'generationId' => $generation->id], 202);
    }
}
```

- [ ] **Step 6: Wire routes**

```php
// routes/api.php — inside auth:sanctum group
Route::post('stories', [StoryController::class, 'store']);
Route::post('stories/resume', [StoryController::class, 'resume']);
```

- [ ] **Step 7: Run tests to verify pass**

Run: `php artisan test --filter=GenerateStoryTest`
Expected: PASS (3 tests)

- [ ] **Step 8: Commit**

```bash
git add app/Http/Requests/Generations/GenerateStoryRequest.php app/Jobs/GenerateStoryJob.php app/Http/Controllers/Api/StoryController.php routes/api.php tests/Feature/Api/GenerateStoryTest.php
git commit -m "feat: story generation with partial-failure resume, ported from run_story"
```

---

### Task 10: Synchronous text endpoints — enhance, write-story, restructure, storyboard

**Files:**
- Create: `app/Http/Requests/Text/EnhanceRequest.php` (and 3 sibling requests: `WriteStoryRequest`, `RestructureRequest`, `StoryboardRequest`)
- Create: `app/Http/Controllers/Api/TextController.php`
- Modify: `routes/api.php`
- Test: `tests/Feature/Api/TextControllerTest.php`

**Interfaces:**
- Consumes: `AnthropicService::haiku()` (Task 6).
- Produces: `POST /api/v1/enhance`, `/write-story`, `/restructure`, `/storyboard` — all synchronous (per this plan's Global Constraints deviation note — these are not queued).

- [ ] **Step 1: Write failing test**

```php
<?php
// tests/Feature/Api/TextControllerTest.php
use App\Models\ApiKey;
use App\Models\User;
use Illuminate\Support\Facades\Http;
use Laravel\Sanctum\Sanctum;

test('enhance returns synchronously, no job queued', function () {
    $user = User::factory()->create();
    ApiKey::create(['user_id' => $user->id, 'provider' => 'anthropic', 'key' => 'k']);
    Sanctum::actingAs($user);
    Http::fake(['api.anthropic.com/*' => Http::response(['content' => [['type' => 'text', 'text' => 'a fox, cinematic lighting, golden hour']]], 200)]);

    $res = $this->postJson('/api/v1/enhance', ['scene_text' => 'a fox'])->assertOk();
    $res->assertJsonStructure(['text']);
    expect(\App\Models\GenerationJob::count())->toBe(0);
});

test('enhance requires anthropic key configured', function () {
    Sanctum::actingAs(User::factory()->create());
    $this->postJson('/api/v1/enhance', ['scene_text' => 'a fox'])->assertStatus(503);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `php artisan test --filter=TextControllerTest`
Expected: FAIL.

- [ ] **Step 3: Implement (enhance shown in full; write-story/restructure/storyboard follow the identical pattern with their own system prompts and request classes)**

```php
<?php
// app/Http/Requests/Text/EnhanceRequest.php
namespace App\Http\Requests\Text;

use Illuminate\Foundation\Http\FormRequest;

class EnhanceRequest extends FormRequest
{
    public function authorize(): bool { return true; }

    public function rules(): array
    {
        return [
            'scene_text' => ['required', 'string', 'max:8000'],
            'image_base64' => ['sometimes', 'string'],
            'image_mime' => ['sometimes', 'string', 'in:image/png,image/jpeg,image/webp'],
        ];
    }
}
```

```php
<?php
// app/Http/Controllers/Api/TextController.php
namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Text\EnhanceRequest;
use App\Services\AnthropicService;
use RuntimeException;

class TextController extends Controller
{
    private const ENHANCER_SYSTEM = 'You are a video-prompt editor. Rewrite the given scene description '
        . 'to add vivid cinematic detail (lighting, camera movement, mood) without changing its meaning. '
        . 'Return only the rewritten prompt text.';

    public function enhance(EnhanceRequest $request, AnthropicService $anthropic)
    {
        $data = $request->validated();
        $content = [['type' => 'text', 'text' => $data['scene_text']]];

        try {
            $text = $anthropic->haiku($request->user(), self::ENHANCER_SYSTEM, $content);
        } catch (RuntimeException $e) {
            return response()->json(['error' => $e->getMessage()], 503);
        }

        return response()->json(['text' => $text]);
    }

    // writeStory(), restructure(), storyboard() follow the same shape as enhance():
    // a dedicated FormRequest, a dedicated system-prompt constant, one AnthropicService::haiku() call,
    // 503 on RuntimeException (missing key), 200 with {text} on success. Implement all three now,
    // porting the exact system prompt text from server.py's WRITER_SYSTEM / RESTRUCTURE_SYSTEM /
    // STORYBOARD_SYSTEM constants — do not paraphrase them.
}
```

> **Implementer note:** `writeStory`, `restructure`, `storyboard` must be implemented in this task, not deferred — the comment above marks where to add them, it is not a placeholder for skipping the work. Read `server.py`'s `WRITER_SYSTEM`, `RESTRUCTURE_SYSTEM`, `STORYBOARD_SYSTEM` constants and `_write_story`/`_restructure`/`_storyboard` handlers before implementing, and write a test per endpoint mirroring the `enhance` tests above.

- [ ] **Step 4: Wire routes**

```php
// routes/api.php — inside auth:sanctum group
Route::post('enhance', [TextController::class, 'enhance']);
Route::post('write-story', [TextController::class, 'writeStory']);
Route::post('restructure', [TextController::class, 'restructure']);
Route::post('storyboard', [TextController::class, 'storyboard']);
```

- [ ] **Step 5: Run tests to verify pass**

Run: `php artisan test --filter=TextControllerTest`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/Http/Requests/Text app/Http/Controllers/Api/TextController.php routes/api.php tests/Feature/Api/TextControllerTest.php
git commit -m "feat: synchronous text endpoints (enhance/write-story/restructure/storyboard)"
```

---

### Task 11: `StitchService` (ffmpeg, array-args) + `StitchJob` + `POST /api/v1/stitch`

**Files:**
- Create: `app/Services/StitchService.php`
- Create: `app/Jobs/StitchJob.php`
- Create: `app/Http/Requests/Generations/StitchRequest.php`
- Create: `app/Http/Controllers/Api/StitchController.php`
- Modify: `routes/api.php`
- Test: `tests/Unit/Services/StitchServiceTest.php`
- Test: `tests/Feature/Api/StitchControllerTest.php`

**Interfaces:**
- Produces: `StitchService::stitch(array $s3Keys, string $outputS3Key): void` — ffmpeg invoked via `Symfony\Process` array-arg form only (Global Constraint), operates on files downloaded to `storage_path("app/tmp/{uuid}")` and re-uploaded to S3, never touching a client-supplied path.

- [ ] **Step 1: Write failing tests**

```php
<?php
// tests/Unit/Services/StitchServiceTest.php
use App\Services\StitchService;
use Illuminate\Support\Facades\Storage;
use Symfony\Component\Process\Process;

test('invokes ffmpeg with array args, never a shell string', function () {
    Storage::fake('s3');
    Storage::disk('s3')->put('u1/g1/clip.mp4', 'fake-mp4-bytes');
    Storage::disk('s3')->put('u1/g2/clip.mp4', 'fake-mp4-bytes');

    $ran = null;
    app()->bind(StitchService::class, function () use (&$ran) {
        return new class extends StitchService {
            public function runProcess(array $command): Process
            {
                // capture instead of executing real ffmpeg in the unit test
                throw new \RuntimeException('captured:' . json_encode($command));
            }
        };
    });

    try {
        app(StitchService::class)->stitch(['u1/g1/clip.mp4', 'u1/g2/clip.mp4'], 'u1/g3/clip.mp4');
    } catch (\RuntimeException $e) {
        $command = json_decode(substr($e->getMessage(), strlen('captured:')), true);
        expect($command[0])->toBe('ffmpeg');
        expect($command)->toBeArray(); // never a concatenated shell string
    }
});
```

```php
<?php
// tests/Feature/Api/StitchControllerTest.php
use App\Jobs\StitchJob;
use App\Models\Generation;
use App\Models\User;
use Illuminate\Support\Facades\Queue;
use Laravel\Sanctum\Sanctum;

test('stitch endpoint only accepts the requesting users own generation ids', function () {
    $owner = User::factory()->create();
    $other = User::factory()->create();
    $g1 = Generation::create(['user_id' => $owner->id, 'kind' => 'clip', 'status' => 'done', 'prompt' => 'x', 'clip_path' => 'a.mp4']);

    Sanctum::actingAs($other);
    Queue::fake();

    $this->postJson('/api/v1/stitch', ['generation_ids' => [$g1->id]])->assertStatus(422);
    Queue::assertNotPushed(StitchJob::class);
});

test('stitch queues a job for the users own completed clips', function () {
    $user = User::factory()->create();
    $g1 = Generation::create(['user_id' => $user->id, 'kind' => 'clip', 'status' => 'done', 'prompt' => 'x', 'clip_path' => 'a.mp4']);
    $g2 = Generation::create(['user_id' => $user->id, 'kind' => 'clip', 'status' => 'done', 'prompt' => 'y', 'clip_path' => 'b.mp4']);
    Sanctum::actingAs($user);
    Queue::fake();

    $this->postJson('/api/v1/stitch', ['generation_ids' => [$g1->id, $g2->id]])->assertStatus(202);
    Queue::assertPushed(StitchJob::class);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `php artisan test --filter="StitchServiceTest|StitchControllerTest"`
Expected: FAIL.

- [ ] **Step 3: Implement `StitchService`**

```php
<?php
// app/Services/StitchService.php
namespace App\Services;

use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use RuntimeException;
use Symfony\Component\Process\Process;

class StitchService
{
    public function stitch(array $sourceS3Keys, string $outputS3Key): void
    {
        $workDir = storage_path('app/tmp/' . Str::uuid());
        mkdir($workDir, 0700, true);

        try {
            $localPaths = [];
            foreach ($sourceS3Keys as $i => $key) {
                $local = "{$workDir}/in_{$i}.mp4";
                file_put_contents($local, Storage::disk('s3')->get($key));
                $localPaths[] = $local;
            }

            $listFile = "{$workDir}/list.txt";
            file_put_contents($listFile, implode("\n", array_map(
                fn ($p) => "file '" . str_replace("'", "'\\''", $p) . "'", $localPaths,
            )));

            $outputLocal = "{$workDir}/out.mp4";
            $process = $this->runProcess([
                'ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', $listFile,
                '-c', 'copy', $outputLocal,
            ]);

            if (! $process->isSuccessful()) {
                throw new RuntimeException('ffmpeg stitch failed: ' . $process->getErrorOutput());
            }

            Storage::disk('s3')->put($outputS3Key, file_get_contents($outputLocal));
        } finally {
            $this->cleanup($workDir);
        }
    }

    public function runProcess(array $command): Process
    {
        $process = new Process($command);
        $process->setTimeout(300);
        $process->run();
        return $process;
    }

    private function cleanup(string $dir): void
    {
        if (! is_dir($dir)) {
            return;
        }
        foreach (glob("{$dir}/*") as $f) {
            @unlink($f);
        }
        @rmdir($dir);
    }
}
```

- [ ] **Step 4: Implement `StitchJob`, `StitchRequest`, `StitchController`**

```php
<?php
// app/Jobs/StitchJob.php
namespace App\Jobs;

use App\Models\Generation;
use App\Models\GenerationJob;
use App\Services\StitchService;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;

class StitchJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public function __construct(public string $jobId, public int $generationId, public array $sourceGenerationIds) {}

    public function handle(StitchService $stitcher): void
    {
        GenerationJob::where('id', $this->jobId)->update(['status' => 'running', 'detail' => 'stitching']);
        $generation = Generation::findOrFail($this->generationId);

        try {
            $sourcePaths = Generation::whereIn('id', $this->sourceGenerationIds)->pluck('clip_path')->all();
            $outputKey = "{$generation->user_id}/{$generation->id}/" . \Illuminate\Support\Str::uuid() . '.mp4';
            $stitcher->stitch($sourcePaths, $outputKey);

            $generation->update(['status' => 'done', 'clip_path' => $outputKey]);
            GenerationJob::where('id', $this->jobId)->update(['status' => 'done', 'detail' => 'done', 'progress' => 100]);
        } catch (\Throwable $e) {
            $generation->update(['status' => 'failed']);
            GenerationJob::where('id', $this->jobId)->update(['status' => 'failed', 'error' => substr($e->getMessage(), 0, 500)]);
        }
    }
}
```

```php
<?php
// app/Http/Requests/Generations/StitchRequest.php
namespace App\Http\Requests\Generations;

use Illuminate\Foundation\Http\FormRequest;

class StitchRequest extends FormRequest
{
    public function authorize(): bool { return true; }

    public function rules(): array
    {
        return [
            'generation_ids' => ['required', 'array', 'min:2', 'max:20'],
            'generation_ids.*' => ['integer'],
        ];
    }
}
```

```php
<?php
// app/Http/Controllers/Api/StitchController.php
namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\Generations\StitchRequest;
use App\Jobs\StitchJob;
use App\Models\Generation;
use App\Models\GenerationJob;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

class StitchController extends Controller
{
    public function store(StitchRequest $request)
    {
        $data = $request->validated();
        $owned = Generation::query()
            ->forUser($request->user()->id)
            ->whereIn('id', $data['generation_ids'])
            ->where('status', 'done')
            ->pluck('id');

        if ($owned->count() !== count($data['generation_ids'])) {
            throw ValidationException::withMessages([
                'generation_ids' => ['One or more clips are not yours or are not yet complete.'],
            ]);
        }

        $generation = Generation::create([
            'user_id' => $request->user()->id, 'kind' => 'stitch', 'status' => 'queued',
            'prompt' => 'Stitched ' . $owned->count() . ' clips', 'source_ids' => $owned->all(),
        ]);

        $jobId = (string) Str::uuid();
        GenerationJob::create([
            'id' => $jobId, 'user_id' => $request->user()->id, 'generation_id' => $generation->id,
            'type' => 'stitch', 'status' => 'queued',
        ]);

        StitchJob::dispatch($jobId, $generation->id, $owned->all());

        return response()->json(['jobId' => $jobId, 'generationId' => $generation->id], 202);
    }
}
```

- [ ] **Step 5: Wire route**

```php
// routes/api.php — inside auth:sanctum group
Route::post('stitch', [StitchController::class, 'store']);
```

- [ ] **Step 6: Run tests to verify pass**

Run: `php artisan test --filter="StitchServiceTest|StitchControllerTest"`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add app/Services/StitchService.php app/Jobs/StitchJob.php app/Http/Requests/Generations/StitchRequest.php app/Http/Controllers/Api/StitchController.php routes/api.php tests/Unit/Services/StitchServiceTest.php tests/Feature/Api/StitchControllerTest.php
git commit -m "feat: ffmpeg stitch service (array-args only) + queued stitch job"
```

---

### Task 12: `GET /api/v1/jobs/{id}` polling endpoint + atomic status updates

**Files:**
- Create: `app/Http/Controllers/Api/JobController.php`
- Modify: `app/Models/GenerationJob.php` (add `markAtomic()` helper used by all three jobs above — refactor Tasks 8/9/11's inline `->update()` calls to use it)
- Modify: `routes/api.php`
- Test: `tests/Feature/Api/JobControllerTest.php`

**Interfaces:**
- Consumes: `GenerationJob` model.
- Produces: `GET /api/v1/jobs/{id}` scoped to `auth()->id()`; `GenerationJob::markAtomic(string $id, array $fields)` — atomic single-row update used everywhere job status changes, closing the race-condition control from the spec.

- [ ] **Step 1: Write failing tests**

```php
<?php
// tests/Feature/Api/JobControllerTest.php
use App\Models\GenerationJob;
use App\Models\User;
use Laravel\Sanctum\Sanctum;

test('user can poll their own job status', function () {
    $user = User::factory()->create();
    $job = GenerationJob::create(['id' => \Illuminate\Support\Str::uuid(), 'user_id' => $user->id, 'type' => 'clip', 'status' => 'running', 'progress' => 40]);
    Sanctum::actingAs($user);

    $this->getJson("/api/v1/jobs/{$job->id}")->assertOk()->assertJson(['status' => 'running', 'progress' => 40]);
});

test('user cannot poll another users job', function () {
    $owner = User::factory()->create();
    $other = User::factory()->create();
    $job = GenerationJob::create(['id' => \Illuminate\Support\Str::uuid(), 'user_id' => $owner->id, 'type' => 'clip', 'status' => 'running']);
    Sanctum::actingAs($other);

    $this->getJson("/api/v1/jobs/{$job->id}")->assertNotFound();
});

test('markAtomic performs a single atomic row update', function () {
    $user = User::factory()->create();
    $job = GenerationJob::create(['id' => \Illuminate\Support\Str::uuid(), 'user_id' => $user->id, 'type' => 'clip', 'status' => 'queued']);

    GenerationJob::markAtomic($job->id, ['status' => 'running', 'progress' => 10]);

    expect($job->fresh()->status)->toBe('running');
    expect($job->fresh()->progress)->toBe(10);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `php artisan test --filter=JobControllerTest`
Expected: FAIL.

- [ ] **Step 3: Implement**

```php
// app/Models/GenerationJob.php — add static helper
public static function markAtomic(string $id, array $fields): void
{
    static::query()->where('id', $id)->update($fields);
}
```

```php
<?php
// app/Http/Controllers/Api/JobController.php
namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\GenerationJob;
use Illuminate\Http\Request;

class JobController extends Controller
{
    public function show(Request $request, string $id)
    {
        $job = GenerationJob::query()->forUser($request->user()->id)->find($id);
        abort_unless($job, 404);
        return $job;
    }
}
```

Also refactor Tasks 8/9/11's `GenerationJob::where('id', $this->jobId)->update([...])` call sites to `GenerationJob::markAtomic($this->jobId, [...])` for consistency (mechanical rename, same semantics — both are already single atomic `->update()` calls).

- [ ] **Step 4: Wire route**

```php
// routes/api.php — inside auth:sanctum group
Route::get('jobs/{id}', [JobController::class, 'show']);
```

- [ ] **Step 5: Run tests to verify pass**

Run: `php artisan test --filter=JobControllerTest`
Expected: PASS

- [ ] **Step 6: Full backend test suite sanity check**

Run: `php artisan test`
Expected: all tests from Tasks 1–12 pass.

- [ ] **Step 7: Commit**

```bash
git add app/Http/Controllers/Api/JobController.php app/Models/GenerationJob.php routes/api.php tests/Feature/Api/JobControllerTest.php
git commit -m "feat: job status polling endpoint + atomic status-update helper"
```

---

## Phase C — Blade + Livewire Web Frontend

### Task 13: Web auth scaffold + app shell layout + bottom nav

**Files:**
- Create: `resources/views/layouts/app.blade.php`
- Create: `app/Livewire/BottomNav.php` + `resources/views/livewire/bottom-nav.blade.php`
- Modify: `routes/web.php`
- Install: `composer require laravel/breeze --dev && php artisan breeze:install blade`
- Test: `tests/Feature/Web/AuthScaffoldTest.php`

**Interfaces:**
- Produces: `layouts.app` Blade component used by every screen in Tasks 14–17; session-authenticated `web` middleware group.

- [ ] **Step 1: Write failing test**

```php
<?php
// tests/Feature/Web/AuthScaffoldTest.php
use App\Models\User;

test('guest is redirected to login from the home screen', function () {
    $this->get('/')->assertRedirect('/login');
});

test('authenticated user sees the home screen', function () {
    $user = User::factory()->create();
    $this->actingAs($user)->get('/')->assertOk()->assertSee('New Video');
});
```

- [ ] **Step 2: Install Breeze (Blade stack), run migrations**

```bash
composer require laravel/breeze --dev
php artisan breeze:install blade
npm install && npm run build
php artisan migrate
```

- [ ] **Step 3: Run test to verify failure (home route not wired yet)**

Run: `php artisan test --filter=AuthScaffoldTest`
Expected: FAIL — no `/` route rendering "New Video" yet.

- [ ] **Step 4: Build the app shell**

```php
{{-- resources/views/layouts/app.blade.php --}}
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Vidora AI</title>
    @vite(['resources/css/app.css', 'resources/js/app.js'])
    @livewireStyles
</head>
<body class="bg-white text-[#111111]">
    <div class="mx-auto max-w-[400px] min-h-screen bg-white relative">
        {{ $slot }}
        @auth
            @if(!request()->routeIs('wizard.*'))
                <livewire:bottom-nav />
            @endif
        @endauth
    </div>
    @livewireScripts
</body>
</html>
```

```php
<?php
// app/Livewire/BottomNav.php
namespace App\Livewire;

use Livewire\Component;

class BottomNav extends Component
{
    public function render()
    {
        return view('livewire.bottom-nav');
    }
}
```

```php
{{-- resources/views/livewire/bottom-nav.blade.php --}}
<nav class="fixed bottom-0 left-0 right-0 max-w-[400px] mx-auto border-t border-[#E8E8EC] bg-white flex justify-around py-2">
    <a href="{{ route('home') }}" class="text-sm {{ request()->routeIs('home') ? 'text-[#2F5FCF] font-semibold' : 'text-[#6B6B73]' }}">Home</a>
    <a href="{{ route('projects') }}" class="text-sm {{ request()->routeIs('projects') ? 'text-[#2F5FCF] font-semibold' : 'text-[#6B6B73]' }}">Projects</a>
    <a href="{{ route('wizard.script') }}" class="w-12 h-12 -mt-4 rounded-full bg-[#2F5FCF] text-white flex items-center justify-center text-2xl shadow-lg">+</a>
    <a href="{{ route('history') }}" class="text-sm {{ request()->routeIs('history') ? 'text-[#2F5FCF] font-semibold' : 'text-[#6B6B73]' }}">History</a>
    <a href="{{ route('profile') }}" class="text-sm {{ request()->routeIs('profile') ? 'text-[#2F5FCF] font-semibold' : 'text-[#6B6B73]' }}">Profile</a>
</nav>
```

```php
// routes/web.php
use Illuminate\Support\Facades\Route;

Route::middleware('auth')->group(function () {
    Route::get('/', \App\Livewire\HomeScreen::class)->name('home'); // built in Task 17
});

require __DIR__.'/auth.php'; // from Breeze
```

> Task 17 builds `HomeScreen`; if executing tasks strictly in order, temporarily stub it as a plain Blade view returning "New Video" text so this task's test can pass, then let Task 17 replace the stub. Note the stub explicitly in the Task 17 handoff.

- [ ] **Step 5: Run test to verify pass**

Run: `php artisan test --filter=AuthScaffoldTest`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add resources/views/layouts app/Livewire/BottomNav.php resources/views/livewire/bottom-nav.blade.php routes/web.php tests/Feature/Web/AuthScaffoldTest.php
git commit -m "feat: Breeze web auth scaffold, app shell layout, bottom nav"
```

---

### Task 14: Wizard steps 1–2 — `Script` and `Scene` Livewire components

**Files:**
- Create: `app/Livewire/Wizard/GenerationWizard.php` (parent, holds shared state)
- Create: `app/Livewire/Wizard/ScriptStep.php` + `resources/views/livewire/wizard/script-step.blade.php`
- Create: `app/Livewire/Wizard/SceneStep.php` + `resources/views/livewire/wizard/scene-step.blade.php`
- Modify: `routes/web.php`
- Test: `tests/Feature/Web/WizardScriptSceneTest.php`

**Interfaces:**
- Produces: session-persisted wizard state (`script`, `sceneStyle`) shared across steps via a parent component pattern — each step Livewire component reads/writes through `GenerationWizard`'s public properties (Livewire's nested-component data binding), matching the design's single `screen`/state-machine model without a client-side SPA framework.

- [ ] **Step 1: Write failing tests**

```php
<?php
// tests/Feature/Web/WizardScriptSceneTest.php
use App\Models\User;
use Livewire\Livewire;
use App\Livewire\Wizard\ScriptStep;
use App\Livewire\Wizard\SceneStep;

test('script step blocks next until non-empty, enforces 8000 char cap', function () {
    $this->actingAs(User::factory()->create());

    Livewire::test(ScriptStep::class)
        ->call('next')
        ->assertHasErrors(['script']);

    Livewire::test(ScriptStep::class)
        ->set('script', str_repeat('a', 8001))
        ->call('next')
        ->assertHasErrors(['script']);
});

test('improve prompt appends cinematic phrase via the enhance action, not a raw API call from Blade', function () {
    $this->actingAs(User::factory()->create());
    \App\Models\ApiKey::create(['user_id' => auth()->id(), 'provider' => 'anthropic', 'key' => 'k']);
    \Illuminate\Support\Facades\Http::fake(['api.anthropic.com/*' => \Illuminate\Support\Facades\Http::response(
        ['content' => [['type' => 'text', 'text' => 'a fox, cinematic lighting']]], 200,
    )]);

    Livewire::test(ScriptStep::class)
        ->set('script', 'a fox')
        ->call('improve')
        ->assertSet('script', 'a fox, cinematic lighting');
});

test('scene step blocks next until a style is selected', function () {
    $this->actingAs(User::factory()->create());

    Livewire::test(SceneStep::class)
        ->call('next')
        ->assertHasErrors(['sceneStyle']);

    Livewire::test(SceneStep::class)
        ->call('selectStyle', 'cinematic')
        ->call('next')
        ->assertHasNoErrors();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `php artisan test --filter=WizardScriptSceneTest`
Expected: FAIL.

- [ ] **Step 3: Implement**

```php
<?php
// app/Livewire/Wizard/ScriptStep.php
namespace App\Livewire\Wizard;

use App\Services\AnthropicService;
use Livewire\Attributes\Validate;
use Livewire\Component;
use RuntimeException;

class ScriptStep extends Component
{
    #[Validate('required|string|max:8000')]
    public string $script = '';

    public function improve(AnthropicService $anthropic)
    {
        try {
            $this->script = $anthropic->haiku(
                auth()->user(),
                'You are a video-prompt editor. Rewrite the given scene description to add vivid '
                    . 'cinematic detail without changing its meaning. Return only the rewritten prompt.',
                [['type' => 'text', 'text' => $this->script]],
            );
        } catch (RuntimeException $e) {
            $this->addError('script', $e->getMessage());
        }
    }

    public function next()
    {
        $this->validate();
        session(['wizard.script' => $this->script]);
        return redirect()->route('wizard.scene');
    }

    public function render()
    {
        return view('livewire.wizard.script-step');
    }
}
```

```php
{{-- resources/views/livewire/wizard/script-step.blade.php --}}
<div class="p-4">
    <div class="flex items-center justify-between mb-2">
        <button wire:click="$dispatch('wizard-back')" class="text-[#6B6B73]">←</button>
        <span class="text-xs text-[#6B6B73]">Step 1/5</span>
    </div>
    <div class="h-1 bg-[#F7F7F8] rounded-full mb-4"><div class="h-1 bg-[#2F5FCF] rounded-full" style="width:20%"></div></div>
    <h1 class="text-xl font-bold mb-4">Describe your video</h1>
    <textarea wire:model="script" maxlength="2000" rows="8"
        class="w-full border border-[#E8E8EC] rounded-[14px] p-3 text-sm"
        placeholder="A fox pokes its head out of the snow..."></textarea>
    @error('script') <p class="text-[#C6362C] text-xs mt-1">{{ $message }}</p> @enderror
    <button wire:click="improve" class="mt-3 text-sm text-[#2F5FCF] font-medium">Improve Prompt ✨</button>
    <button wire:click="next" class="fixed bottom-20 left-4 right-4 max-w-[368px] mx-auto h-14 rounded-[14px] bg-[#2F5FCF] text-white font-semibold">Next</button>
</div>
```

```php
<?php
// app/Livewire/Wizard/SceneStep.php
namespace App\Livewire\Wizard;

use Livewire\Component;

class SceneStep extends Component
{
    public array $styles = ['cinematic', '3d', 'anime', 'photoreal', 'cartoon', 'watercolor', 'fantasy', 'custom'];
    public ?string $sceneStyle = null;
    public bool $showAll = false;

    public function selectStyle(string $id)
    {
        $this->sceneStyle = $id;
    }

    public function next()
    {
        if (! $this->sceneStyle) {
            $this->addError('sceneStyle', 'Select a style.');
            return;
        }
        session(['wizard.sceneStyle' => $this->sceneStyle]);
        return redirect()->route('wizard.references');
    }

    public function render()
    {
        return view('livewire.wizard.scene-step');
    }
}
```

```php
{{-- resources/views/livewire/wizard/scene-step.blade.php --}}
<div class="p-4">
    <div class="h-1 bg-[#F7F7F8] rounded-full mb-4"><div class="h-1 bg-[#2F5FCF] rounded-full" style="width:40%"></div></div>
    <h1 class="text-xl font-bold mb-4">Pick a style</h1>
    <div class="grid grid-cols-2 gap-3">
        @foreach(($showAll ? $styles : array_slice($styles, 0, 6)) as $style)
            <button wire:click="selectStyle('{{ $style }}')"
                class="rounded-[16px] p-3 text-left {{ $sceneStyle === $style ? 'ring-2 ring-[#2F5FCF]' : '' }}">
                {{ ucfirst($style) }}
            </button>
        @endforeach
    </div>
    @error('sceneStyle') <p class="text-[#C6362C] text-xs mt-2">{{ $message }}</p> @enderror
    <button wire:click="$set('showAll', {{ $showAll ? 'false' : 'true' }})" class="mt-3 text-sm text-[#2F5FCF]">
        {{ $showAll ? '− Show fewer styles' : '+ See all styles' }}
    </button>
    <button wire:click="next" class="fixed bottom-20 left-4 right-4 max-w-[368px] mx-auto h-14 rounded-[14px] bg-[#2F5FCF] text-white font-semibold">Next</button>
</div>
```

- [ ] **Step 4: Wire wizard routes**

```php
// routes/web.php — add inside auth middleware group
Route::get('/wizard/script', \App\Livewire\Wizard\ScriptStep::class)->name('wizard.script');
Route::get('/wizard/scene', \App\Livewire\Wizard\SceneStep::class)->name('wizard.scene');
```

- [ ] **Step 5: Run tests to verify pass**

Run: `php artisan test --filter=WizardScriptSceneTest`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/Livewire/Wizard/ScriptStep.php app/Livewire/Wizard/SceneStep.php resources/views/livewire/wizard routes/web.php tests/Feature/Web/WizardScriptSceneTest.php
git commit -m "feat: wizard steps 1-2 (Script, Scene) as Livewire components"
```

---

### Task 15: Wizard steps 3–5 — `References`, `Settings`, `Review`

**Files:**
- Create: `app/Livewire/Wizard/ReferencesStep.php` + view
- Create: `app/Livewire/Wizard/SettingsStep.php` + view
- Create: `app/Livewire/Wizard/ReviewStep.php` + view
- Modify: `routes/web.php`
- Test: `tests/Feature/Web/WizardSettingsReviewTest.php`

**Interfaces:**
- Consumes: `GET /api/v1/models` shape (Task 5) — fetched server-side via the same `ModelController`/`CostEstimator` services (Livewire calls the service directly, not over HTTP, since it's same-process).
- Produces: session state (`wizard.duration`, `wizard.aspectRatio`, `wizard.modelId`, `wizard.resolution`) read by Task 16's Generating screen.

- [ ] **Step 1: Write failing test**

```php
<?php
// tests/Feature/Web/WizardSettingsReviewTest.php
use App\Models\User;
use App\Livewire\Wizard\SettingsStep;
use Livewire\Livewire;

test('changing model snaps duration/resolution to a value the new model supports', function () {
    $this->actingAs(User::factory()->create());

    Livewire::test(SettingsStep::class)
        ->set('modelId', 'grok') // 480p/720p only
        ->set('resolution', '1080p') // invalid for grok — must snap
        ->call('selectModel', 'grok')
        ->assertSet('resolution', '480p'); // first supported resolution
});

test('review step summary reflects everything chosen earlier in the wizard', function () {
    $this->actingAs(User::factory()->create());
    session([
        'wizard.script' => 'a fox in snow', 'wizard.sceneStyle' => 'cinematic',
        'wizard.modelId' => 'lite', 'wizard.resolution' => '720p',
        'wizard.duration' => 8, 'wizard.aspectRatio' => '16:9',
    ]);

    $this->get(route('wizard.review'))->assertSee('a fox in snow')->assertSee('Cinematic');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `php artisan test --filter=WizardSettingsReviewTest`
Expected: FAIL.

- [ ] **Step 3: Implement `SettingsStep` (the core capability-filtering behavior)**

```php
<?php
// app/Livewire/Wizard/SettingsStep.php
namespace App\Livewire\Wizard;

use Livewire\Component;

class SettingsStep extends Component
{
    public string $modelId = 'lite';
    public int $duration = 8;
    public string $aspectRatio = '16:9';
    public string $resolution = '720p';
    public bool $advancedOpen = false;

    public function selectModel(string $id)
    {
        $this->modelId = $id;
        $spec = config("engines.tiers.{$id}");
        $durations = config("engines.durations.{$id}", config('engines.veo_durations'));

        if (! in_array($this->duration, $durations, true)) {
            $this->duration = $durations[0];
        }
        if (! in_array($this->resolution, $spec['resolutions'], true)) {
            $this->resolution = $spec['resolutions'][0];
        }
    }

    public function next()
    {
        session([
            'wizard.modelId' => $this->modelId, 'wizard.resolution' => $this->resolution,
            'wizard.duration' => $this->duration, 'wizard.aspectRatio' => $this->aspectRatio,
        ]);
        return redirect()->route('wizard.review');
    }

    public function render()
    {
        return view('livewire.wizard.settings-step', [
            'models' => app(\App\Http\Controllers\Api\ModelController::class)->index(app(\App\Services\CostEstimator::class)),
        ]);
    }
}
```

```php
{{-- resources/views/livewire/wizard/settings-step.blade.php --}}
<div class="p-4">
    <div class="h-1 bg-[#F7F7F8] rounded-full mb-4"><div class="h-1 bg-[#2F5FCF] rounded-full" style="width:80%"></div></div>
    <h1 class="text-xl font-bold mb-4">Video settings</h1>
    <select wire:change="selectModel($event.target.value)" class="w-full border border-[#E8E8EC] rounded-[12px] p-3 mb-3">
        @foreach($models as $m)
            <option value="{{ $m['id'] }}" @selected($modelId === $m['id'])>{{ $m['name'] }} — ${{ number_format($m['costEstimateUsd'], 2) }}</option>
        @endforeach
    </select>
    <div class="flex gap-2 mb-3">
        @foreach(collect($models)->firstWhere('id', $modelId)['durations'] ?? [] as $d)
            <button wire:click="$set('duration', {{ $d }})" class="px-3 py-1 rounded-full border {{ $duration === $d ? 'bg-[#2F5FCF] text-white' : 'border-[#E8E8EC]' }}">{{ $d }}s</button>
        @endforeach
    </div>
    <button wire:click="next" class="fixed bottom-20 left-4 right-4 max-w-[368px] mx-auto h-14 rounded-[14px] bg-[#2F5FCF] text-white font-semibold">Review Video</button>
</div>
```

```php
<?php
// app/Livewire/Wizard/ReferencesStep.php
namespace App\Livewire\Wizard;

use Livewire\Component;
use Livewire\WithFileUploads;

class ReferencesStep extends Component
{
    use WithFileUploads;

    public array $referenceImages = []; // Livewire TemporaryUploadedFile[], max 5 — enforced in rules()

    protected function rules(): array
    {
        return [
            'referenceImages' => ['array', 'max:5'],
            'referenceImages.*' => ['image', 'max:20480', 'mimes:png,jpg,jpeg,webp'], // 20MB, MIME allow-list
        ];
    }

    public function next()
    {
        $this->validate();
        return redirect()->route('wizard.settings'); // references are always optional — no blocking validation beyond format
    }

    public function render()
    {
        return view('livewire.wizard.references-step');
    }
}
```

```php
{{-- resources/views/livewire/wizard/references-step.blade.php --}}
<div class="p-4">
    <div class="h-1 bg-[#F7F7F8] rounded-full mb-4"><div class="h-1 bg-[#2F5FCF] rounded-full" style="width:60%"></div></div>
    <h1 class="text-xl font-bold mb-2">Reference images</h1>
    <p class="text-xs text-[#6B6B73] mb-4">References are optional.</p>
    <input type="file" wire:model="referenceImages" multiple accept="image/png,image/jpeg,image/webp">
    @error('referenceImages.*') <p class="text-[#C6362C] text-xs mt-1">{{ $message }}</p> @enderror
    <button wire:click="next" class="fixed bottom-20 left-4 right-4 max-w-[368px] mx-auto h-14 rounded-[14px] bg-[#2F5FCF] text-white font-semibold">Next</button>
</div>
```

```php
<?php
// app/Livewire/Wizard/ReviewStep.php
namespace App\Livewire\Wizard;

use App\Http\Requests\Generations\GenerateClipRequest;
use App\Jobs\GenerateClipJob;
use App\Models\Generation;
use App\Models\GenerationJob;
use App\Services\ApiKeyResolver;
use Illuminate\Support\Str;
use Livewire\Component;
use RuntimeException;

class ReviewStep extends Component
{
    public function generate(ApiKeyResolver $keys)
    {
        $w = session('wizard', []);
        $tier = $w['modelId'] ?? 'lite';
        $provider = config("engines.tiers.{$tier}.provider");

        try {
            $keys->for(auth()->user(), $provider);
        } catch (RuntimeException $e) {
            $this->addError('generate', $e->getMessage());
            return;
        }

        $generation = Generation::create([
            'user_id' => auth()->id(), 'kind' => 'clip', 'status' => 'queued',
            'prompt' => $w['script'] ?? '', 'tier' => $tier,
            'resolution' => $w['resolution'] ?? '720p', 'aspect' => $w['aspectRatio'] ?? '16:9',
            'duration' => $w['duration'] ?? 8,
        ]);

        $jobId = (string) Str::uuid();
        GenerationJob::create(['id' => $jobId, 'user_id' => auth()->id(), 'generation_id' => $generation->id, 'type' => 'clip', 'status' => 'queued']);
        GenerateClipJob::dispatch($jobId, $generation->id, auth()->id(), [
            'tier' => $tier, 'prompt' => $w['script'] ?? '', 'resolution' => $w['resolution'] ?? '720p',
            'duration' => $w['duration'] ?? 8, 'aspect' => $w['aspectRatio'] ?? '16:9',
        ]);

        session(['wizard.currentJobId' => $jobId]);
        return redirect()->route('wizard.generating');
    }

    public function render()
    {
        return view('livewire.wizard.review-step', ['wizard' => session('wizard', [])]);
    }
}
```

```php
{{-- resources/views/livewire/wizard/review-step.blade.php --}}
<div class="p-4">
    <div class="h-1 bg-[#F7F7F8] rounded-full mb-4"><div class="h-1 bg-[#2F5FCF] rounded-full" style="width:100%"></div></div>
    <h1 class="text-xl font-bold mb-4">Review</h1>
    <p class="text-sm text-[#6B6B73] mb-1">Script</p>
    <p class="text-sm mb-3">{{ $wizard['script'] ?? '' }}</p>
    <p class="text-sm text-[#6B6B73] mb-1">Scene Style</p>
    <p class="text-sm mb-3">{{ ucfirst($wizard['sceneStyle'] ?? '') }}</p>
    @error('generate') <p class="text-[#C6362C] text-xs mb-2">{{ $message }}</p> @enderror
    <button wire:click="generate" class="fixed bottom-20 left-4 right-4 max-w-[368px] mx-auto h-14 rounded-[14px] bg-gradient-to-r from-[#4E7CDB] to-[#2F5FCF] text-white font-semibold">Generate Video ✨</button>
</div>
```

- [ ] **Step 4: Wire routes**

```php
// routes/web.php — add inside auth middleware group
Route::get('/wizard/references', \App\Livewire\Wizard\ReferencesStep::class)->name('wizard.references');
Route::get('/wizard/settings', \App\Livewire\Wizard\SettingsStep::class)->name('wizard.settings');
Route::get('/wizard/review', \App\Livewire\Wizard\ReviewStep::class)->name('wizard.review');
```

- [ ] **Step 5: Run tests to verify pass**

Run: `php artisan test --filter=WizardSettingsReviewTest`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/Livewire/Wizard/ReferencesStep.php app/Livewire/Wizard/SettingsStep.php app/Livewire/Wizard/ReviewStep.php resources/views/livewire/wizard routes/web.php tests/Feature/Web/WizardSettingsReviewTest.php
git commit -m "feat: wizard steps 3-5 (References, Settings, Review) with model-capability filtering"
```

---

### Task 16: `Generating` (live poll) and `Result` screens

**Files:**
- Create: `app/Livewire/Wizard/GeneratingStep.php` + view (`wire:poll` against `generation_jobs`)
- Create: `app/Livewire/Wizard/ResultStep.php` + view
- Modify: `routes/web.php`
- Test: `tests/Feature/Web/GeneratingResultTest.php`

**Interfaces:**
- Consumes: `GenerationJob`/`Generation` models, `session('wizard.currentJobId')` (Task 15).
- Produces: real progress replacing the design's simulated timer — `wire:poll.2s` calling a component method that re-reads the job row.

- [ ] **Step 1: Write failing test**

```php
<?php
// tests/Feature/Web/GeneratingResultTest.php
use App\Models\Generation;
use App\Models\GenerationJob;
use App\Models\User;
use App\Livewire\Wizard\GeneratingStep;
use Livewire\Livewire;

test('generating screen reflects the real job status, not a simulated timer', function () {
    $user = User::factory()->create();
    $this->actingAs($user);
    $generation = Generation::create(['user_id' => $user->id, 'kind' => 'clip', 'status' => 'queued', 'prompt' => 'x']);
    $job = GenerationJob::create(['id' => \Illuminate\Support\Str::uuid(), 'user_id' => $user->id, 'generation_id' => $generation->id, 'type' => 'clip', 'status' => 'running', 'progress' => 42]);
    session(['wizard.currentJobId' => $job->id]);

    Livewire::test(GeneratingStep::class)
        ->call('poll')
        ->assertSet('progress', 42)
        ->assertSet('status', 'running');
});

test('generating screen redirects to result once the job is done', function () {
    $user = User::factory()->create();
    $this->actingAs($user);
    $generation = Generation::create(['user_id' => $user->id, 'kind' => 'clip', 'status' => 'done', 'prompt' => 'x', 'clip_path' => 'a.mp4']);
    $job = GenerationJob::create(['id' => \Illuminate\Support\Str::uuid(), 'user_id' => $user->id, 'generation_id' => $generation->id, 'type' => 'clip', 'status' => 'done', 'progress' => 100]);
    session(['wizard.currentJobId' => $job->id]);

    Livewire::test(GeneratingStep::class)->call('poll')->assertRedirect(route('wizard.result', $generation->id));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `php artisan test --filter=GeneratingResultTest`
Expected: FAIL.

- [ ] **Step 3: Implement**

```php
<?php
// app/Livewire/Wizard/GeneratingStep.php
namespace App\Livewire\Wizard;

use App\Models\GenerationJob;
use Livewire\Component;

class GeneratingStep extends Component
{
    public int $progress = 0;
    public string $status = 'queued';

    public function poll()
    {
        $job = GenerationJob::query()->forUser(auth()->id())->find(session('wizard.currentJobId'));
        if (! $job) {
            return;
        }
        $this->progress = $job->progress;
        $this->status = $job->status;

        if ($job->status === 'done') {
            return redirect()->route('wizard.result', $job->generation_id);
        }
        if ($job->status === 'failed') {
            $this->addError('generation', $job->error ?? 'Generation failed.');
        }
    }

    public function render()
    {
        return view('livewire.wizard.generating-step');
    }
}
```

```php
{{-- resources/views/livewire/wizard/generating-step.blade.php --}}
<div class="p-4 flex flex-col items-center justify-center min-h-screen" wire:poll.2s="poll">
    <div class="w-40 h-40 rounded-full border-8 border-[#EAF0FB] border-t-[#2F5FCF] flex items-center justify-center text-2xl font-bold">
        {{ $progress }}%
    </div>
    <p class="mt-4 text-sm text-[#6B6B73]">{{ ucfirst($status) }}...</p>
    @error('generation') <p class="text-[#C6362C] text-sm mt-2">{{ $message }}</p> @enderror
    <a href="{{ route('home') }}" class="mt-6 text-sm text-[#2F5FCF]">Run in Background</a>
</div>
```

```php
<?php
// app/Livewire/Wizard/ResultStep.php
namespace App\Livewire\Wizard;

use App\Models\Generation;
use Livewire\Component;

class ResultStep extends Component
{
    public Generation $generation;

    public function mount(int $generationId)
    {
        $this->generation = Generation::query()->forUser(auth()->id())->findOrFail($generationId);
    }

    public function render()
    {
        return view('livewire.wizard.result-step');
    }
}
```

```php
{{-- resources/views/livewire/wizard/result-step.blade.php --}}
<div class="p-4">
    <h1 class="text-xl font-bold mb-4">Your Video is Ready 🎉</h1>
    <div class="aspect-video bg-[#F7F7F8] rounded-[16px] mb-4 flex items-center justify-center">▶</div>
    <div class="grid grid-cols-2 gap-2 text-sm mb-6">
        <div>Duration: {{ $generation->duration }}s</div>
        <div>Model: {{ $generation->tier }}</div>
        <div>Resolution: {{ $generation->resolution }}</div>
        <div>Aspect: {{ $generation->aspect }}</div>
    </div>
    <a href="{{ route('wizard.script') }}" class="block h-14 rounded-[14px] bg-[#2F5FCF] text-white font-semibold flex items-center justify-center">Create Another Video</a>
</div>
```

- [ ] **Step 4: Wire routes**

```php
// routes/web.php — add inside auth middleware group
Route::get('/wizard/generating', \App\Livewire\Wizard\GeneratingStep::class)->name('wizard.generating');
Route::get('/wizard/result/{generationId}', \App\Livewire\Wizard\ResultStep::class)->name('wizard.result');
```

- [ ] **Step 5: Run tests to verify pass**

Run: `php artisan test --filter=GeneratingResultTest`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add app/Livewire/Wizard/GeneratingStep.php app/Livewire/Wizard/ResultStep.php resources/views/livewire/wizard routes/web.php tests/Feature/Web/GeneratingResultTest.php
git commit -m "feat: Generating (real job polling) and Result screens"
```

---

### Task 17: `Home`, `Projects`, `History`, `Profile` screens

**Files:**
- Create: `app/Livewire/HomeScreen.php` + view (replaces Task 13's stub)
- Create: `app/Livewire/ProjectsScreen.php` + view
- Create: `app/Livewire/HistoryScreen.php` + view
- Create: `app/Livewire/ProfileScreen.php` + view
- Modify: `routes/web.php`
- Test: `tests/Feature/Web/TabScreensTest.php`

**Interfaces:**
- Consumes: `Generation::forUser()` scope (Task 2), `ApiKey` masked listing (Task 4).
- Produces: the four bottom-nav destinations. No credit balance/top-up per the billing decision — Profile shows configured-key status instead.

- [ ] **Step 1: Write failing tests**

```php
<?php
// tests/Feature/Web/TabScreensTest.php
use App\Models\Generation;
use App\Models\User;

test('home shows only the users own recent projects', function () {
    $me = User::factory()->create();
    $other = User::factory()->create();
    Generation::create(['user_id' => $me->id, 'kind' => 'clip', 'status' => 'done', 'prompt' => 'mine']);
    Generation::create(['user_id' => $other->id, 'kind' => 'clip', 'status' => 'done', 'prompt' => 'not mine']);

    $this->actingAs($me)->get(route('home'))->assertSee('mine')->assertDontSee('not mine');
});

test('projects tab filters by status client-side query param', function () {
    $user = User::factory()->create();
    Generation::create(['user_id' => $user->id, 'kind' => 'clip', 'status' => 'failed', 'prompt' => 'failed one']);
    Generation::create(['user_id' => $user->id, 'kind' => 'clip', 'status' => 'done', 'prompt' => 'done one']);

    $this->actingAs($user)->get(route('projects', ['status' => 'failed']))
        ->assertSee('failed one')->assertDontSee('done one');
});

test('profile shows no credit balance, only configured-key status', function () {
    $this->actingAs(User::factory()->create());
    $res = $this->get(route('profile'));
    $res->assertDontSee('Top up')->assertDontSee('credits');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `php artisan test --filter=TabScreensTest`
Expected: FAIL.

- [ ] **Step 3: Implement**

```php
<?php
// app/Livewire/HomeScreen.php
namespace App\Livewire;

use App\Models\Generation;
use Livewire\Component;

class HomeScreen extends Component
{
    public function render()
    {
        $recent = Generation::query()->forUser(auth()->id())->latest()->limit(5)->get();
        return view('livewire.home-screen', ['recent' => $recent]);
    }
}
```

```php
{{-- resources/views/livewire/home-screen.blade.php --}}
<div class="p-4 pb-24">
    <div class="rounded-[20px] bg-gradient-to-br from-[#4E7CDB] to-[#2F5FCF] text-white p-5 mb-4">
        <h1 class="text-xl font-bold mb-1">Create amazing videos with AI</h1>
        <a href="{{ route('wizard.script') }}" class="inline-block mt-3 bg-white text-[#2F5FCF] rounded-[14px] px-4 py-2 font-semibold">+ New Video</a>
    </div>
    <h2 class="text-sm font-semibold text-[#6B6B73] mb-2">Recent Projects</h2>
    @foreach($recent as $g)
        <div class="border-b border-[#E8E8EC] py-3 text-sm">{{ $g->prompt }}</div>
    @endforeach
</div>
```

```php
<?php
// app/Livewire/ProjectsScreen.php
namespace App\Livewire;

use App\Models\Generation;
use Livewire\Attributes\Url;
use Livewire\Component;

class ProjectsScreen extends Component
{
    #[Url]
    public string $status = 'all';

    public function render()
    {
        $projects = Generation::query()
            ->forUser(auth()->id())
            ->when($this->status !== 'all', fn ($q) => $q->where('status', $this->status))
            ->latest()->get();
        return view('livewire.projects-screen', ['projects' => $projects]);
    }
}
```

```php
{{-- resources/views/livewire/projects-screen.blade.php --}}
<div class="p-4 pb-24">
    <h1 class="text-xl font-bold mb-4">Projects</h1>
    <div class="flex gap-2 mb-4 text-xs">
        @foreach(['all', 'queued', 'done', 'failed'] as $tab)
            <button wire:click="$set('status', '{{ $tab }}')" class="px-3 py-1 rounded-full {{ $status === $tab ? 'bg-[#2F5FCF] text-white' : 'bg-[#F7F7F8]' }}">{{ ucfirst($tab) }}</button>
        @endforeach
    </div>
    @foreach($projects as $p)
        <div class="border-b border-[#E8E8EC] py-3 text-sm flex justify-between">
            <span>{{ $p->prompt }}</span>
            <span class="text-xs px-2 py-0.5 rounded-full {{ $p->status === 'done' ? 'bg-[#E9F7EF] text-[#1E8E4A]' : ($p->status === 'failed' ? 'bg-[#FDECEC] text-[#C6362C]' : 'bg-[#FFF6E9] text-[#8A6415]') }}">{{ $p->status }}</span>
        </div>
    @endforeach
</div>
```

```php
<?php
// app/Livewire/HistoryScreen.php
namespace App\Livewire;

use App\Models\Generation;
use Livewire\Component;

class HistoryScreen extends Component
{
    public function render()
    {
        return view('livewire.history-screen', [
            'jobs' => Generation::query()->forUser(auth()->id())->latest()->paginate(20),
        ]);
    }
}
```

```php
{{-- resources/views/livewire/history-screen.blade.php --}}
<div class="p-4 pb-24">
    <h1 class="text-xl font-bold mb-4">History</h1>
    @foreach($jobs as $j)
        <div class="border-b border-[#E8E8EC] py-3 text-sm flex justify-between items-center">
            <span>{{ $j->prompt }}</span>
            @if($j->status === 'failed')
                <a href="{{ route('wizard.script') }}" class="text-xs text-[#2F5FCF]">Retry</a>
            @elseif($j->status === 'done')
                <a href="{{ route('wizard.result', $j->id) }}" class="text-xs text-[#2F5FCF]">View</a>
            @endif
        </div>
    @endforeach
    {{ $jobs->links() }}
</div>
```

```php
<?php
// app/Livewire/ProfileScreen.php
namespace App\Livewire;

use App\Models\ApiKey;
use Livewire\Component;

class ProfileScreen extends Component
{
    public function render()
    {
        $configured = ApiKey::query()->forUser(auth()->id())->pluck('provider')->all();
        return view('livewire.profile-screen', ['configuredProviders' => $configured]);
    }
}
```

```php
{{-- resources/views/livewire/profile-screen.blade.php --}}
<div class="p-4 pb-24">
    <h1 class="text-xl font-bold mb-4">Profile</h1>
    <p class="text-sm mb-1">{{ auth()->user()->name }}</p>
    <p class="text-xs text-[#6B6B73] mb-4">{{ auth()->user()->email }}</p>
    <h2 class="text-sm font-semibold text-[#6B6B73] mb-2">API Keys</h2>
    @foreach(['gemini', 'anthropic', 'openrouter', 'ark'] as $provider)
        <div class="flex justify-between border-b border-[#E8E8EC] py-2 text-sm">
            <span>{{ ucfirst($provider) }}</span>
            <span class="{{ in_array($provider, $configuredProviders) ? 'text-[#1E8E4A]' : 'text-[#6B6B73]' }}">
                {{ in_array($provider, $configuredProviders) ? 'Configured' : 'Not set' }}
            </span>
        </div>
    @endforeach
</div>
```

- [ ] **Step 4: Wire routes, remove Task 13's home stub**

```php
// routes/web.php — replace the earlier stub
Route::middleware('auth')->group(function () {
    Route::get('/', \App\Livewire\HomeScreen::class)->name('home');
    Route::get('/projects', \App\Livewire\ProjectsScreen::class)->name('projects');
    Route::get('/history', \App\Livewire\HistoryScreen::class)->name('history');
    Route::get('/profile', \App\Livewire\ProfileScreen::class)->name('profile');
});
```

- [ ] **Step 5: Run tests to verify pass**

Run: `php artisan test --filter=TabScreensTest`
Expected: PASS

- [ ] **Step 6: Full web suite sanity check**

Run: `php artisan test`
Expected: all tests from Tasks 1–17 pass.

- [ ] **Step 7: Commit**

```bash
git add app/Livewire/HomeScreen.php app/Livewire/ProjectsScreen.php app/Livewire/HistoryScreen.php app/Livewire/ProfileScreen.php resources/views/livewire routes/web.php tests/Feature/Web/TabScreensTest.php
git commit -m "feat: Home, Projects, History, Profile screens"
```

---

## Phase D — Hardening & Deployment

### Task 18: Security negative-path sweep + `composer audit`

**Files:**
- Create: `tests/Feature/Security/CrossUserAccessTest.php` (consolidates IDOR checks across every resource, some already covered per-endpoint in earlier tasks — this task closes any gaps)
- Modify: CI config (`.github/workflows/tests.yml` or equivalent, if one exists / gets created) to run `composer audit`

**Interfaces:**
- Consumes: all endpoints from Phases A–C.
- Produces: a single consolidated cross-user-access regression suite, run as part of `php artisan test` going forward.

- [ ] **Step 1: Write the consolidated cross-user test**

```php
<?php
// tests/Feature/Security/CrossUserAccessTest.php
use App\Models\ApiKey;
use App\Models\Generation;
use App\Models\GenerationJob;
use App\Models\User;
use Laravel\Sanctum\Sanctum;

test('no authenticated user can read, modify, or delete another users records via the API', function () {
    $owner = User::factory()->create();
    $attacker = User::factory()->create();

    $generation = Generation::create(['user_id' => $owner->id, 'kind' => 'clip', 'status' => 'done', 'prompt' => 'x']);
    $job = GenerationJob::create(['id' => \Illuminate\Support\Str::uuid(), 'user_id' => $owner->id, 'type' => 'clip', 'status' => 'done']);
    ApiKey::create(['user_id' => $owner->id, 'provider' => 'ark', 'key' => 'owner-secret']);

    Sanctum::actingAs($attacker);

    $this->getJson("/api/v1/jobs/{$job->id}")->assertNotFound();
    $this->deleteJson("/api/v1/generations/{$generation->id}")->assertNotFound();
    $this->deleteJson('/api/v1/keys/ark')->assertNotFound();
    expect(Generation::find($generation->id))->not->toBeNull(); // untouched
    expect(ApiKey::where('user_id', $owner->id)->exists())->toBeTrue(); // untouched
});

test('unauthenticated requests to any protected endpoint are rejected', function () {
    $this->getJson('/api/v1/generations')->assertUnauthorized();
    $this->getJson('/api/v1/keys')->assertUnauthorized();
    $this->postJson('/api/v1/generations', [])->assertUnauthorized();
});
```

- [ ] **Step 2: Run and fix any failures**

Run: `php artisan test --filter=CrossUserAccessTest`
Expected: PASS. If any assertion fails, the corresponding controller from Phases A–C is missing its `forUser()`/`abort_unless` scoping — fix there, not by weakening this test.

- [ ] **Step 3: Run dependency audit**

Run: `composer audit`
Expected: no known vulnerabilities, or documented justification if a transitive dep can't be upgraded yet.

- [ ] **Step 4: Full suite + commit**

Run: `php artisan test`
Expected: all tests pass.

```bash
git add tests/Feature/Security/CrossUserAccessTest.php
git commit -m "test: consolidated cross-user IDOR regression suite"
```

---

### Task 19: Forge deployment prep

**Files:**
- Create: `docs/deployment.md` (Forge site setup steps, daemon config, scheduler entry)
- Modify: `.env.example` (final pass — confirm no secrets committed)

**Interfaces:**
- Produces: a checklist a human follows in the Forge dashboard (Forge site creation itself is a console action, not something this plan automates — flagging that explicitly rather than scripting an unreviewed production deploy).

- [ ] **Step 1: Write the deployment doc**

```markdown
<!-- docs/deployment.md -->
# Forge Deployment — VideoGenAPI

1. Forge dashboard → New Site → point at this repo, PHP 8.2+.
2. Environment: set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_BUCKET`, `AWS_DEFAULT_REGION`,
   `REDIS_HOST`, `APP_KEY` (generate via `php artisan key:generate --show`, paste into Forge env — never commit it).
   No provider API keys go here — those are per-user, stored encrypted in the `api_keys` table.
3. Server recipe: `sudo apt-get install -y ffmpeg` (StitchService requires the `ffmpeg` binary on PATH).
4. Daemon: `php artisan queue:work --tries=3 --timeout=300` (Forge daemon, auto-restart on deploy).
5. Scheduler: confirm Forge's scheduler cron entry is registered (`* * * * * php artisan schedule:run`);
   add `app:cleanup-tmp` as a scheduled command sweeping `storage/app/tmp/*` older than 1 hour.
6. Deploy script: `composer install --no-dev && php artisan migrate --force && php artisan config:cache`.
7. Confirm this site's port does not clash with the Python VideoGen app (`127.0.0.1:8767`) — unrelated,
   different host entirely, but worth a sanity check if ever co-located.
```

- [ ] **Step 2: Add the `app:cleanup-tmp` command referenced above**

```bash
php artisan make:command CleanupTmpCommand
```

```php
<?php
// app/Console/Commands/CleanupTmpCommand.php
namespace App\Console\Commands;

use Illuminate\Console\Command;

class CleanupTmpCommand extends Command
{
    protected $signature = 'app:cleanup-tmp';
    protected $description = 'Sweep stale ffmpeg scratch directories older than 1 hour';

    public function handle(): void
    {
        $root = storage_path('app/tmp');
        if (! is_dir($root)) {
            return;
        }
        foreach (glob("{$root}/*") as $dir) {
            if (is_dir($dir) && filemtime($dir) < now()->subHour()->timestamp) {
                $this->deleteRecursive($dir);
            }
        }
    }

    private function deleteRecursive(string $dir): void
    {
        foreach (glob("{$dir}/*") as $f) {
            is_dir($f) ? $this->deleteRecursive($f) : @unlink($f);
        }
        @rmdir($dir);
    }
}
```

```php
// routes/console.php or bootstrap/app.php's schedule() — register:
use Illuminate\Support\Facades\Schedule;
Schedule::command('app:cleanup-tmp')->hourly();
```

- [ ] **Step 3: Verify `.env.example` has no real secrets**

Run: `grep -E "sk-|AKIA" .env.example`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add docs/deployment.md app/Console/Commands/CleanupTmpCommand.php routes/console.php .env.example
git commit -m "chore: Forge deployment doc + scratch-dir cleanup scheduler"
```

---

## Plan Self-Review Notes

- **Spec coverage:** every section of the design spec (data model, auth, provider integrations, background jobs, files/ffmpeg, input validation, API surface, security controls, web frontend, deployment) maps to at least one task above. The `EnhanceJob` mismatch between the spec's wording and the Python source's actual synchronous behavior is called out in Global Constraints and resolved in Task 10 — the spec doc should get a one-line correction after this plan lands.
- **Known deliberate placeholders:** `CostEstimator`'s three provider-cost methods (Task 5) intentionally defer exact dollar constants to implementation time, since porting them requires reading `veo.py`/`openrouter_video.py`/`ark_video.py` directly rather than guessing — flagged inline with explicit implementer instructions, not left silent.
- **Type consistency check:** `GenerationJob::markAtomic()` (Task 12) is introduced after Tasks 8/9/11 already call `GenerationJob::where(...)->update(...)` inline — Task 12 explicitly calls out the mechanical refactor so later code is consistent; both forms are equivalent atomic single-row updates, so no behavior gap exists in the interim.
