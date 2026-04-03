// NBIG Offline Engine v3 — Complete Mock API covering ALL 47 endpoints
(function() {
    console.log("NBIG Offline Engine v3 Loaded");

    // ═══ MOCK SOCKET.IO — must be defined FIRST ═══
    window.io = function() {
        return {
            on: function(ev, cb) {},
            emit: function(ev, d) {},
            disconnect: function() {}
        };
    };

    // ═══ MOCK DATA STORE ═══
    let walletBalance = 1500.0;
    let notifications = [
        { id: "n1", title: "Welcome to NBIG", message: "Your smart transit companion is ready.", is_read: false, type: "info", created_at: new Date().toISOString() },
        { id: "n2", title: "Wallet Credited", message: "₹1500 added to your wallet.", is_read: false, type: "info", created_at: new Date(Date.now()-3600000).toISOString() }
    ];
    let bookings = [
        { id: "NBIG-A1B2", route_name: "Downtown Express", bus_number: "NB-001X", from_stop: "Central Hub", to_stop: "Tech Park", seat_number: "14", fare: 15, payment_method: "wallet", payment_status: "paid", status: "confirmed", boarded: false, auto_refunded: false, created_at: new Date().toISOString(), user_name: "Hackathon Dev" }
    ];
    const ROUTES = [
        {id:"r1", route_number:"NB-R1", name:"Downtown Express", origin:"Central Hub", destination:"Tech Park", stops:["Central Hub","City Mall","Hospital","University","Tech Park"], distance_km:12, duration_min:35, base_fare:15, weekly_pass_fare:200, surge_multiplier:1.0},
        {id:"r2", route_number:"NB-R2", name:"Airport Shuttle", origin:"Airport T1", destination:"Railway Station", stops:["Airport T1","Highway Junction","Bus Stand","Railway Station"], distance_km:22, duration_min:50, base_fare:30, weekly_pass_fare:400, surge_multiplier:1.2},
        {id:"r3", route_number:"NB-R3W", name:"Women Special - Safe Route", origin:"South Gate", destination:"North Plaza", stops:["South Gate","Ladies College","Market","North Plaza"], distance_km:8, duration_min:25, base_fare:10, weekly_pass_fare:120, surge_multiplier:1.0}
    ];
    const BUSES = [
        {id:"b1", bus_number:"NB-001X", route_id:"r1", route_name:"Downtown Express", conductor_id:"c1", conductor_name:"Raj Kumar", capacity:50, model:"Tata Starbus EV", reg_number:"NB001X", is_active:true},
        {id:"b2", bus_number:"NB-777", route_id:"r2", route_name:"Airport Shuttle", conductor_id:"c2", conductor_name:"Priya Singh", capacity:60, model:"Volvo 9400", reg_number:"NB777", is_active:true},
        {id:"b3", bus_number:"NB-R3W-01", route_id:"r3", route_name:"Women Special", conductor_id:"c3", conductor_name:"Anita Devi", capacity:40, model:"Ashok Leyland", reg_number:"NBR3W01", is_active:true}
    ];
    const TRIPS = [
        {id:"t1", trip_id:"t1", bus_id:"b1", bus_number:"NB-001X", route_id:"r1", route_name:"Downtown Express", origin:"Central Hub", destination:"Tech Park", lat:27.575, lng:81.590, delay_minutes:0, passenger_count:18, capacity:50, crowd_pct:36, crowd_label:"Comfortable", distance_from_user_km:0.8, eta_minutes:3, fare:15, baseFare:15, surge:1.0, isPeak:false, speed:42, trip_status:"in_progress", departure:"14:30", conductor_name:"Raj Kumar", fromStop:"Central Hub", toStop:"Tech Park", availableSeats:32, current_stop_index:1, predicted_crowd_pct:45},
        {id:"t2", trip_id:"t2", bus_id:"b2", bus_number:"NB-777", route_id:"r2", route_name:"Airport Shuttle", origin:"Airport T1", destination:"Railway Station", lat:27.568, lng:81.602, delay_minutes:5, passenger_count:52, capacity:60, crowd_pct:87, crowd_label:"Crowded", distance_from_user_km:2.1, eta_minutes:8, fare:36, baseFare:30, surge:1.2, isPeak:true, speed:55, trip_status:"in_progress", departure:"14:00", conductor_name:"Priya Singh", fromStop:"Airport T1", toStop:"Railway Station", availableSeats:8, current_stop_index:2, predicted_crowd_pct:92}
    ];
    const CONDUCTORS = [
        {id:"c1", name:"Raj Kumar", email:"raj@nbig.com", phone:"9876543001", role:"conductor", is_active:true},
        {id:"c2", name:"Priya Singh", email:"priya@nbig.com", phone:"9876543002", role:"conductor", is_active:true},
        {id:"c3", name:"Anita Devi", email:"anita@nbig.com", phone:"9876543003", role:"conductor", is_active:true}
    ];
    const PASSENGERS = [
        {id:"p1", name:"Hackathon Dev", email:"dev@nbig.com", phone:"9876543210", role:"passenger", wallet:1500, trip_count:42, home_stop:"Central Hub", work_stop:"Tech Park", is_active:true},
        {id:"p2", name:"Meera Sharma", email:"meera@nbig.com", phone:"9876543211", role:"passenger", wallet:800, trip_count:18, home_stop:"Airport T1", work_stop:"Railway Station", is_active:true}
    ];
    let currentUserRole = "passenger";

    // ═══ ROUTER — handles ALL 47+ endpoints ═══
    function route(method, url, body) {
        body = body || {};
        const path = url.split('?')[0].replace(/\/$/, '');

        // ── AUTH ──
        if (path === '/api/auth/login') {
            const role = body.email?.includes("admin") ? "admin" : body.email?.includes("conductor") ? "conductor" : "passenger";
            currentUserRole = role;
            return { token: "nbig_tok_" + Date.now(), user: { id: "u1", name: role === "admin" ? "Admin Pro" : role === "conductor" ? "Raj Kumar" : "Hackathon Dev", email: body.email, role: role, phone: "9876543210" }};
        }
        if (path === '/api/auth/register') {
            currentUserRole = body.role || "passenger";
            return { token: "nbig_tok_" + Date.now(), user: { id: "u_new", name: body.name, email: body.email, role: body.role || "passenger", phone: body.phone }};
        }
        if (path === '/api/auth/me') return { id: "u1", name: "Hackathon Dev", email: "dev@nbig.com", role: currentUserRole, phone: "9876543210", wallet: walletBalance, carbon_saved: 55.4, paper_saved: 42, home_stop: "Central Hub", work_stop: "Tech Park", weekly_pass_expiry: new Date(Date.now() + 86400000*5).toISOString().split('T')[0], subsidized_verified: true, subsidized_type: "Student" };
        if (path === '/api/auth/profile') return { success: true };

        // ── TRIPS ──
        if (path === '/api/trips/live') return TRIPS;
        if (path === '/api/trips/search') return TRIPS.map(t => ({...t, bus_eta_min: t.eta_minutes, arrival_at_stop_min: t.eta_minutes+5, bus_distance_km: t.distance_from_user_km, weekly_pass_fare: 200}));
        if (path.match(/\/api\/trips\/[^/]+\/seats/)) return { booked: ["1","3","7","12","18","22","25","30","35","40"], locked: ["8","15"] };

        // ── BOOKINGS ──
        if (path === '/api/bookings/lock-seat') return { success: true };
        if (path === '/api/bookings/create-order') {
            if (body.payment_method === 'wallet') {
                walletBalance = Math.max(0, walletBalance - (body.fare || 15));
                const bk = { id: "NBIG-" + Math.random().toString(36).substr(2,6).toUpperCase(), seat_number: body.seat_number, fare: body.fare, from_stop: body.from_stop, to_stop: body.to_stop, status: "confirmed", payment_status: "paid", payment_method: "wallet", bus_number: "NB-001X", route_name: "Downtown Express", boarded: false, auto_refunded: false, created_at: new Date().toISOString(), user_name: "Hackathon Dev" };
                bookings.unshift(bk);
                return { success: true, booking_id: bk.id, qr_code: "NBIG_QR_" + bk.id };
            }
            return { success: false, demo_mode: true, order_id: "ORD_" + Date.now() };
        }
        if (path === '/api/bookings/verify-payment') {
            const bk = { id: "NBIG-" + Math.random().toString(36).substr(2,6).toUpperCase(), seat_number: body.seat_number || "7", fare: body.fare || 15, from_stop: "Central Hub", to_stop: "Tech Park", status: "confirmed", payment_status: "paid", payment_method: "razorpay", bus_number: "NB-001X", route_name: "Downtown Express", boarded: false, auto_refunded: false, created_at: new Date().toISOString(), user_name: "Hackathon Dev" };
            bookings.unshift(bk);
            return { booking: bk };
        }
        if (path === '/api/bookings/my') return bookings;
        if (path.match(/\/api\/bookings\/[^/]+\/cancel/)) {
            if (bookings.length > 0) { bookings[0].status = "cancelled"; walletBalance += bookings[0].fare; }
            return { success: true, refund: true };
        }

        // ── WALLET ──
        if (path === '/api/wallet') return { balance: walletBalance, transactions: [
            { type: "credit", amount: 1500, balance_after: 1500, description: "Welcome Bonus", created_at: new Date(Date.now()-86400000).toISOString() },
            { type: "debit", amount: 15, balance_after: 1485, description: "Booking NB-001X Seat 14", created_at: new Date().toISOString() }
        ]};
        if (path === '/api/wallet/topup') return { demo_mode: true, order_id: "TOP_" + Date.now() };
        if (path === '/api/wallet/topup/confirm') { walletBalance += (body.amount || 100); return { balance: walletBalance }; }

        // ── PASS & SUBSIDY ──
        if (path === '/api/pass/buy') { walletBalance -= 200; return { success: true, expiry: new Date(Date.now()+604800000).toISOString().split('T')[0] }; }
        if (path === '/api/subsidized-fare/verify') return { verified: true };

        // ── ALERTS & INCIDENTS ──
        if (path === '/api/alerts' && method === 'GET') return [
            { id: "a1", alert_type: "traffic_jam", description: "Heavy congestion near City Mall junction — expect 10min delay", upvotes: 24, reporter: "Traffic AI", severity: "medium" },
            { id: "a2", alert_type: "road_closure", description: "Main St closed for maintenance until 6PM", upvotes: 8, reporter: "Municipal Corp", severity: "high" }
        ];
        if (path === '/api/alerts' && method === 'POST') return { success: true, id: "a_" + Date.now() };
        if (path.match(/\/api\/alerts\/[^/]+\/upvote/)) return { success: true, upvotes: 25 };
        if (path === '/api/incidents' && method === 'GET') return [
            { id: "i1", type: "safety", description: "Broken step on Bus NB-777", status: "investigating", created_at: new Date().toISOString() }
        ];
        if (path === '/api/incidents/report') return { success: true, id: "inc_" + Date.now() };
        if (path.match(/\/api\/incidents\/[^/]+\/status/)) return { success: true };

        // ── NOTIFICATIONS ──
        if (path === '/api/notifications') return notifications;
        if (path === '/api/notifications/read-all') { notifications.forEach(n => n.is_read = true); return { success: true }; }

        // ── ROUTES ──
        if (path === '/api/routes') return ROUTES;

        // ── CONDUCTOR ──
        if (path === '/api/conductor/trip' && method === 'GET') return {...TRIPS[0], id: TRIPS[0].trip_id, stops: ROUTES[0].stops, current_stop_index: 1};
        if (path === '/api/conductor/schedules') return [
            { id: "s1", route_name: "Downtown Express", bus_number: "NB-001X", origin: "Central Hub", destination: "Tech Park", departure: "06:00 AM", arrival: "06:35 AM", status: "completed", date: new Date().toISOString().split('T')[0] },
            { id: "s2", route_name: "Downtown Express", bus_number: "NB-001X", origin: "Central Hub", destination: "Tech Park", departure: "02:30 PM", arrival: "03:05 PM", status: "in_progress", date: new Date().toISOString().split('T')[0] },
            { id: "s3", route_name: "Downtown Express", bus_number: "NB-001X", origin: "Central Hub", destination: "Tech Park", departure: "06:00 PM", arrival: "06:35 PM", status: "scheduled", date: new Date().toISOString().split('T')[0] }
        ];
        if (path === '/api/conductor/trip/start') return { success: true, trip_id: "t_new_" + Date.now() };
        if (path === '/api/conductor/trip/complete') return { success: true };
        if (path === '/api/conductor/stop/advance') return { success: true, current_stop_index: 2 };
        if (path === '/api/conductor/delay') return { success: true };
        if (path === '/api/conductor/scan') return { valid: true, passenger: "Hackathon Dev", seat: "14", from: "Central Hub", to: "Tech Park" };
        if (path.match(/\/api\/conductor\/trip\/[^/]+\/passengers/)) return [
            { seat_number: "14", name: "Hackathon Dev", phone: "9876543210", from_stop: "Central Hub", to_stop: "Tech Park", payment_method: "wallet", boarded: true },
            { seat_number: "22", name: "Meera Sharma", phone: "9876543211", from_stop: "City Mall", to_stop: "Tech Park", payment_method: "razorpay", boarded: false }
        ];
        if (path === '/api/conductor/collect') return { success: true, receipt: "RCP-" + Date.now() };
        if (path === '/api/conductor/location') return { success: true };
        if (path === '/api/conductor/sos') return { success: true };

        // ── ADMIN ──
        if (path === '/api/admin/stats') return { active_buses: 3, bookings_today: 248, revenue_today: 12500, on_time_rate: 96, total_passengers: PASSENGERS.length, total_conductors: CONDUCTORS.length, total_routes: ROUTES.length, delayed_trips: 1, auto_refunds_today: 2, sos_active: 0 };
        if (path === '/api/admin/buses' && method === 'GET') return BUSES;
        if (path === '/api/admin/buses' && method === 'POST') { BUSES.push({...body, id: "b_" + Date.now(), is_active: true}); return { success: true }; }
        if (path.match(/\/api\/admin\/buses\//) && method === 'PUT') return { success: true };
        if (path.match(/\/api\/admin\/buses\//) && method === 'DELETE') return { success: true };
        if (path === '/api/admin/fleet') return TRIPS.map(t => ({...t, bus_number: t.bus_number, conductor_name: t.conductor_name, route_name: t.route_name, passenger_count: t.passenger_count, capacity: t.capacity, speed: t.speed, delay_minutes: t.delay_minutes, fare_collected: Math.round(Math.random()*2000), trip_status: t.trip_status, lat: t.lat, lng: t.lng, sos_active: false}));
        if (path === '/api/admin/routes' && method === 'POST') return { success: true };
        if (path.match(/\/api\/admin\/routes\/[^/]+\/surge/)) return { success: true };
        if (path === '/api/admin/users' && method === 'POST') return { success: true };
        if (path === '/api/admin/users' && method === 'GET' && url.includes('conductor')) return CONDUCTORS;
        if (path === '/api/admin/users' && method === 'GET' && url.includes('passenger')) return PASSENGERS;
        if (path === '/api/admin/users' && method === 'GET') return [...CONDUCTORS, ...PASSENGERS];
        if (path.match(/\/api\/admin\/users\//) && method === 'PATCH') return { success: true };
        if (path === '/api/admin/assign') return { success: true };
        if (path === '/api/admin/bookings') return bookings;
        if (path === '/api/admin/revenue') return {
            daily: Array.from({length:7}, (_, i) => ({ date: new Date(Date.now()-i*86400000).toISOString().split('T')[0], total: Math.round(8000+Math.random()*8000), count: Math.round(100+Math.random()*200) })),
            byRoute: ROUTES.map(r => ({ name: r.name, bookings: Math.round(30+Math.random()*100), revenue: Math.round(1000+Math.random()*5000) })),
            hourly: Array.from({length:24}, (_, h) => ({ hour: h, count: h>=7&&h<=9||h>=17&&h<=19 ? Math.round(20+Math.random()*30) : Math.round(Math.random()*15) }))
        };
        if (path === '/api/admin/heatmap') {
            const stops = ["Central Hub","City Mall","Hospital","University","Tech Park","Airport T1","Bus Stand","Railway Station"];
            const data = [];
            stops.forEach(stop => { for(let h=0;h<24;h++) { if(Math.random()>0.4) data.push({ stop, hour: h, demand: Math.round(Math.random()*50) }); }});
            return data;
        }
        if (path === '/api/admin/schedules' && method === 'GET') return [
            { id:"sc1", bus_number:"NB-001X", route_name:"Downtown Express", conductor_name:"Raj Kumar", date:new Date().toISOString().split('T')[0], departure:"06:00", arrival:"06:35", status:"completed" },
            { id:"sc2", bus_number:"NB-777", route_name:"Airport Shuttle", conductor_name:"Priya Singh", date:new Date().toISOString().split('T')[0], departure:"14:00", arrival:"14:50", status:"started" },
            { id:"sc3", bus_number:"NB-R3W-01", route_name:"Women Special", conductor_name:"Anita Devi", date:new Date().toISOString().split('T')[0], departure:"18:00", arrival:"18:25", status:"scheduled" }
        ];
        if (path === '/api/admin/schedules' && method === 'POST') return { success: true };
        if (path === '/api/admin/broadcast') return { success: true, sent: 120 };
        if (path === '/api/admin/ev-stations' && method === 'GET') return [
            { id: "ev1", name: "Central Hub Charging", location: "Central Hub Bus Terminal", chargers: 4, available: 2, power_kw: 150 },
            { id: "ev2", name: "Tech Park Station", location: "Tech Park Depot", chargers: 6, available: 5, power_kw: 200 }
        ];
        if (path === '/api/admin/ev-stations' && method === 'POST') return { success: true };
        if (path.match(/\/api\/admin\/ev-stations\//) && method === 'DELETE') return { success: true };
        if (path === '/api/admin/incidents') return [
            { id: "i1", type: "safety", description: "Broken step on Bus NB-777", status: "investigating", reporter: "Priya Singh", created_at: new Date().toISOString() }
        ];

        // ── CATCH-ALL ──
        console.warn("NBIG unmocked:", method, path);
        return { success: true, data: [] };
    }

    // ═══ INTERCEPT fetch() ═══
    const _fetch = window.fetch;
    window.fetch = async function(resource, config) {
        const url = typeof resource === 'string' ? resource : (resource?.url || '');
        if (url.includes('/api/')) {
            let body = {};
            try { body = config?.body ? JSON.parse(config.body) : {}; } catch(e) {}
            const result = route(config?.method || 'GET', url, body);
            return { ok: true, json: async () => result };
        }
        return _fetch(resource, config);
    };

    // ═══ INTERCEPT api() global function ═══
    window.api = async function(method, url, body) {
        return route(method, url, body || {});
    };

    // Also override GET/POST/etc helpers if they exist
    window.addEventListener('load', function() {
        if (typeof window.GET !== 'undefined') {
            const origGET = window.GET;
            window.GET = async function(url) { return route('GET', url, {}); };
        }
    });

})();
