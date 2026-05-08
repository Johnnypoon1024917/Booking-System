document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = document.getElementById('username').value;
    const p = document.getElementById('password').value;
    const errDiv = document.getElementById('loginError');

    try {
        const res = await fetch('/api/v1/login', {
            method: 'POST',
            headers: { 'X-Username': u, 'X-Password': p }
        });

        if (res.ok) {
            const data = await res.json();
            // Securely store the JWT token in sessionStorage (cleared when tab closes)
            sessionStorage.setItem('fsd_jwt', data.token);
            sessionStorage.setItem('fsd_role', data.role);
            sessionStorage.setItem('fsd_user', u);
            
            // Redirect to the secured dashboard
            window.location.href = '/views/dashboard.html';
        } else {
            throw new Error("Invalid Active Directory Credentials");
        }
    } catch (err) {
        errDiv.innerText = err.message;
        errDiv.classList.remove('hidden');
    }
});