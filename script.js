class FamilyLocator {
    constructor() {
        const supabaseUrl = 'https://epijxziihqnhwghiuuej.supabase.co';
        const supabaseKey = 'sb_publishable_jhEJpUlCTOX6sDsyn5_z_w_6iLEoHFs';

        this.supabase = supabase.createClient(supabaseUrl, supabaseKey);

        this.map = null;
        this.userMarker = null;
        this.familyMarkers = new Map();
        this.watchId = null;
        this.isSharing = false;
        this.isOwner = false;
        this.myVisible = true;                    // ← sua privacidade
        this.userId = crypto.randomUUID();
        this.userName = localStorage.getItem('familyName') || prompt('👤 Seu nome na família:') || 'Pai';
        localStorage.setItem('familyName', this.userName);

        const params = new URLSearchParams(location.search);
        this.roomId = params.get('room') || crypto.randomUUID().slice(0, 8);
        if (!params.get('room')) history.replaceState(null, '', `?room=${this.roomId}`);

        this.init();
    }

    async init() {
        this.bindEvents();
        await this.loadMap();
        await this.setupOwnership();
        this.listenToFamily();
        this.updateStatus('🟢 Conectado!', 'Clique em Iniciar Compartilhamento', '#4ecdc4');
        this.generateQR();
    }

    bindEvents() {
        document.getElementById('shareBtn').onclick = () => this.startSharing();
        document.getElementById('stopBtn').onclick = () => this.stopSharing();
        document.getElementById('copyBtn').onclick = () => this.copyLink();
    }

    async loadMap() {
        this.map = L.map('map').setView([-23.5505, -46.6333], 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(this.map);
    }

    async setupOwnership() {
        const { data } = await this.supabase.from('family_rooms').select('owner_id').eq('room_id', this.roomId).single();
        if (!data?.owner_id) {
            await this.supabase.from('family_rooms').upsert({ room_id: this.roomId, owner_id: this.userId });
            this.isOwner = true;
        } else {
            this.isOwner = data.owner_id === this.userId;
        }
        if (this.isOwner) this.createAdminPanel();
    }

    createAdminPanel() {
        const panel = document.createElement('div');
        panel.id = 'adminPanel';
        panel.style.cssText = 'background:#fff3cd;padding:20px;margin:15px 25px;border-radius:15px;border:2px solid #ffc107;';
        panel.innerHTML = `<h3 style="color:#d39e00;margin-bottom:15px;">👑 Painel do Pai - Gerenciar Membros</h3><div id="pendingList" style="max-height:300px;overflow-y:auto;"></div>`;
        document.querySelector('.container').insertBefore(panel, document.getElementById('mapContainer'));
    }

    updateStatus(title, msg, color = '#4ecdc4') {
        document.getElementById('statusTitle').textContent = title;
        document.getElementById('statusMessage').textContent = msg;
        document.getElementById('statusIcon').style.color = color;
    }

    showToast(msg) {
        const t = document.createElement('div');
        t.style.cssText = 'position:fixed;bottom:30px;left:50%;transform:translateX(-50%);padding:15px 25px;border-radius:12px;color:white;z-index:9999;background:#4ecdc4;';
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 3000);
    }

    updateUI(sharing) {
        document.getElementById('shareBtn').style.display = sharing ? 'none' : 'block';
        document.getElementById('stopBtn').style.display = sharing ? 'block' : 'none';
        document.getElementById('mapContainer').style.display = sharing ? 'block' : 'none';
        document.getElementById('familySection').style.display = sharing ? 'block' : 'none';
        document.getElementById('qrSection').style.display = sharing ? 'block' : 'none';
    }

    startSharing() {
        if (this.isSharing) return;
        if (!navigator.geolocation) return this.showToast('Geolocalização não suportada');

        this.watchId = navigator.geolocation.watchPosition(
            pos => this.onLocationUpdate(pos),
            err => this.showToast('Erro GPS: ' + err.message),
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );

        this.isSharing = true;
        this.updateUI(true);
        this.updateStatus('📍 Compartilhando...', 'Localização em tempo real', '#45b7d1');
        this.showToast('✅ Compartilhamento iniciado!');

        // Toggle de privacidade (só o Pai)
        if (this.isOwner) {
            const toggleDiv = document.createElement('div');
            toggleDiv.style.cssText = 'padding:15px 25px;background:#f8f9ff;margin:15px 25px;border-radius:15px;display:flex;align-items:center;justify-content:space-between;';
            toggleDiv.innerHTML = `
                <span style="font-weight:600;">Mostrar minha localização para a família</span>
                <label class="switch" style="position:relative;display:inline-block;width:52px;height:28px;">
                    <input type="checkbox" id="myVisibleToggle" checked>
                    <span style="position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#ccc;transition:.4s;border-radius:28px;"></span>
                </label>
            `;
            document.querySelector('.map-container').prepend(toggleDiv);

            const cb = document.getElementById('myVisibleToggle');
            cb.onchange = () => {
                this.myVisible = cb.checked;
                this.onLocationUpdate({ coords: { latitude: this.lastLat || -23.55, longitude: this.lastLng || -46.63, accuracy: 10 } });
                this.showToast(this.myVisible ? '✅ Você está visível' : '👁️ Você está oculto para as filhas');
            };
        }
    }

    async stopSharing() {
        if (this.watchId) navigator.geolocation.clearWatch(this.watchId);
        await this.supabase.from('family_locations').update({ online: false }).eq('user_id', this.userId).eq('room_id', this.roomId);
        this.isSharing = false;
        this.updateUI(false);
        if (this.userMarker) this.map.removeLayer(this.userMarker);
        this.showToast('🛑 Parado');
    }

    async onLocationUpdate(position) {
        const { latitude, longitude, accuracy } = position.coords;
        this.lastLat = latitude;
        this.lastLng = longitude;
        const now = new Date().toISOString();

        await this.supabase.from('family_locations').upsert({
            room_id: this.roomId,
            user_id: this.userId,
            user_name: this.userName,
            latitude, longitude, accuracy,
            online: true,
            approved: this.isOwner ? true : false,
            visible: this.isOwner ? this.myVisible : true,
            updated_at: now
        });

        this.updateUserMarker(latitude, longitude);
        this.map.setView([latitude, longitude], 16);
        this.refreshFamily();
    }

    updateUserMarker(lat, lng) {
        if (this.userMarker) this.userMarker.setLatLng([lat, lng]);
        else {
            this.userMarker = L.marker([lat, lng], { icon: L.divIcon({ html: '👤', iconSize: [40,40] }) }).addTo(this.map);
        }
    }

    listenToFamily() {
        this.supabase.channel('family-locator')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'family_locations', filter: `room_id=eq.${this.roomId}` },
                () => this.refreshFamily())
            .subscribe();
    }

    async refreshFamily() {
        const { data } = await this.supabase
            .from('family_locations')
            .select('*')
            .eq('room_id', this.roomId)
            .order('updated_at', { ascending: false });

        const now = Date.now();
        const filterApproved = !this.isOwner; // Pai vê tudo, filhas só aprovados

        const family = (data || []).filter(loc => {
            const age = (now - new Date(loc.updated_at)) / 1000;
            if (loc.user_id === this.userId || age > 180) return false;
            return filterApproved ? (loc.approved && loc.visible) : true;
        });

        this.updateFamilyMarkers(family);
        this.updateFamilyList(family);

        if (this.isOwner) this.updateAdminPanel(data || []);
    }

    updateFamilyMarkers(family) {
        this.familyMarkers.forEach(m => this.map.removeLayer(m));
        this.familyMarkers.clear();

        family.forEach(loc => {
            const marker = L.marker([loc.latitude, loc.longitude], {
                icon: L.divIcon({ html: '👩‍👧', iconSize: [36,36] })
            }).addTo(this.map);
            marker.bindPopup(`<b>${loc.user_name}</b><br>Online agora`);
            this.familyMarkers.set(loc.user_id, marker);
        });
    }

    updateFamilyList(family) {
        const list = document.getElementById('familyList');
        const count = document.getElementById('onlineCount');
        count.textContent = family.length;
        list.innerHTML = '';

        family.forEach(m => {
            const div = document.createElement('div');
            div.className = 'family-member online';
            div.innerHTML = `
                <div class="family-avatar" style="background:#4ecdc4">${m.user_name[0]}</div>
                <div class="family-info"><h4>${m.user_name}</h4><p><i class="fas fa-circle"></i> Online • agora</p></div>`;
            list.appendChild(div);
        });
    }

    updateAdminPanel(allUsers) {
        const pending = allUsers.filter(u => u.user_id !== this.userId && !u.approved);
        const html = pending.length === 0 
            ? '<p style="color:#666;text-align:center;padding:20px;">Nenhum membro pendente ✓ Todas aprovadas</p>'
            : pending.map(u => `
                <div style="background:white;padding:15px;margin:10px 0;border-radius:12px;border:1px solid #ffc107;display:flex;justify-content:space-between;align-items:center;">
                    <div>
                        <b>${u.user_name}</b><br>
                        <small>📍 ${u.latitude.toFixed(4)}, ${u.longitude.toFixed(4)}</small>
                    </div>
                    <div>
                        <button onclick="window.app.approve('${u.user_id}')" style="background:#4ecdc4;color:white;padding:10px 18px;border:none;border-radius:8px;margin-right:8px;">Aprovar</button>
                        <button onclick="window.app.block('${u.user_id}')" style="background:#ff6b6b;color:white;padding:10px 18px;border:none;border-radius:8px;">Bloquear</button>
                    </div>
                </div>
            `).join('');

        const container = document.getElementById('pendingList');
        if (container) container.innerHTML = html;
    }

    async approve(userId) {
        await this.supabase.from('family_locations').update({ approved: true }).eq('user_id', userId).eq('room_id', this.roomId);
        this.refreshFamily();
        this.showToast('✅ Membro aprovado e agora visível!');
    }

    async block(userId) {
        await this.supabase.from('family_locations').update({ approved: false }).eq('user_id', userId).eq('room_id', this.roomId);
        this.refreshFamily();
        this.showToast('🚫 Membro bloqueado');
    }

    generateQR() {
        const link = `${location.origin}${location.pathname}?room=${this.roomId}`;
        document.getElementById('shareLink').value = link;
        const qrDiv = document.getElementById('qrCode');
        qrDiv.innerHTML = '';
        new QRCode(qrDiv, { text: link, width: 200, height: 200 });
    }

    copyLink() {
        navigator.clipboard.writeText(document.getElementById('shareLink').value);
        this.showToast('✅ Link copiado!');
    }
}

// Inicia
window.app = new FamilyLocator();