// ===== Shared Utility Functions =====
// Used by both host.js and participant.js

// --- Avatar Colors ---
const AVATAR_COLORS = ['667eea', '764ba2', 'f093fb', '4facfe', '43e97b', 'fa709a', 'fee140', 'ff6b6b', '4ecdc4', '45b7d1'];

/**
 * Get a DiceBear avatar URL for a player name.
 * @param {string} name - Player name used as seed
 * @param {number} index - Index for color selection
 * @returns {string} Avatar image URL
 */
function getAvatarUrl(name, index) {
  const color = AVATAR_COLORS[index % AVATAR_COLORS.length];
  return `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name)}&backgroundColor=${color}&fontSize=40`;
}

/**
 * Get a consistent avatar URL based on a hash of the player name.
 * @param {string} name - Player name
 * @returns {string} Avatar image URL
 */
function getAvatarUrlByName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % AVATAR_COLORS.length;
  const color = AVATAR_COLORS[index];
  return `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name)}&backgroundColor=${color}&fontSize=40`;
}

/**
 * Cache and return a DiceBear avatar as a data URL.
 * @param {string} seed - Avatar seed (usually display name)
 * @param {string} backgroundColor - Hex color without #
 * @returns {Promise<string>} Data URL or fallback URL
 */
async function getCachedAvatar(seed, backgroundColor = '667eea') {
  const cacheKey = `avatar_${seed}_${backgroundColor}`;
  const cached = sessionStorage.getItem(cacheKey);
  if (cached) return cached;

  const avatarUrl = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(seed)}&backgroundColor=${backgroundColor}&fontSize=40`;
  try {
    const response = await fetch(avatarUrl);
    const svgText = await response.text();
    const dataUrl = 'data:image/svg+xml,' + encodeURIComponent(svgText);
    sessionStorage.setItem(cacheKey, dataUrl);
    return dataUrl;
  } catch (error) {
    console.error('Failed to fetch avatar:', error);
    return avatarUrl;
  }
}

// --- Cookie Helpers ---

function setCookie(name, value, days = 365) {
  const date = new Date();
  date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
  const expires = "expires=" + date.toUTCString();
  document.cookie = name + "=" + value + ";" + expires + ";path=/";
}

function getCookie(name) {
  const nameEQ = name + "=";
  const ca = document.cookie.split(';');
  for (let i = 0; i < ca.length; i++) {
    let c = ca[i];
    while (c.charAt(0) === ' ') c = c.substring(1, c.length);
    if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
  }
  return null;
}

// --- Toast / Notification ---

/**
 * Show a toast notification.
 * @param {string} message - Text to display
 * @param {'info'|'success'|'error'} type - Notification type
 */
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  const bgColor = type === 'success' ? 'bg-green-500' :
    type === 'error' ? 'bg-red-500' : 'bg-blue-500';

  toast.className = `fixed bottom-4 right-4 px-6 py-3 rounded-lg shadow-lg z-50 ${bgColor} text-white font-medium transform transition-all`;
  toast.textContent = message;
  toast.style.transform = 'translateY(100px)';

  document.body.appendChild(toast);

  setTimeout(() => { toast.style.transform = 'translateY(0)'; }, 10);

  setTimeout(() => {
    toast.style.transform = 'translateY(100px)';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// --- Reconnection Overlays ---

function showReconnectingOverlay(reconnectAttempts, maxAttempts) {
  hideReconnectingOverlay();

  const overlay = document.createElement('div');
  overlay.id = 'reconnectOverlay';
  overlay.className = 'fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50';
  overlay.innerHTML = `
    <div class="bg-white rounded-lg p-8 text-center max-w-md">
      <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
      <p class="text-lg font-semibold text-gray-800">Connection lost</p>
      <p class="text-gray-600 mt-2">Attempting to reconnect...</p>
      <p id="reconnectAttemptCount" class="text-sm text-gray-500 mt-4">Attempt ${reconnectAttempts + 1}/${maxAttempts}</p>
    </div>
  `;
  document.body.appendChild(overlay);
}

function updateReconnectingOverlay(reconnectAttempts, maxAttempts) {
  const el = document.getElementById('reconnectAttemptCount');
  if (el) {
    el.textContent = `Attempt ${reconnectAttempts}/${maxAttempts}`;
  }
}

function hideReconnectingOverlay() {
  const overlay = document.getElementById('reconnectOverlay');
  if (overlay) overlay.remove();
}

function showConnectionFailedError(message = 'Unable to reconnect to the server') {
  const overlay = document.createElement('div');
  overlay.id = 'connectionFailedOverlay';
  overlay.className = 'fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50';
  overlay.innerHTML = `
    <div class="bg-white rounded-lg p-8 text-center max-w-md">
      <div class="text-red-500 text-5xl mb-4" aria-hidden="true">&#9888;&#65039;</div>
      <p class="text-lg font-semibold text-gray-800 mb-2">Connection Failed</p>
      <p class="text-gray-600 mb-6">${message}</p>
      <button onclick="location.reload()" class="px-6 py-2 bg-primary text-white rounded-lg hover:bg-primary-dark">
        Refresh Page
      </button>
    </div>
  `;
  document.body.appendChild(overlay);
}
