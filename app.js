const express=require("express");
require("dotenv").config();
const apiRoute=require("./Routes/apiRoute");
const {google}=require("googleapis");
const axios=require("axios");
const dayjs=require("dayjs");
const app=express();
const mongoose=require("mongoose");
const nodemailer = require("nodemailer");
const {v4 :uuidv4}=require("uuid")
const User=require("./Models/user");
app.use("/api",apiRoute);
app.use(express.json())
mongoose.connect('mongodb://127.0.0.1:27017/oppointment', { useNewUrlParser: true, useUnifiedTopology: true });
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => console.log('Connected to MongoDB'));

// -------------------------------------------------------------------------------------------------------
const calendar=google.calendar({
    version:"v3",//the third version of an API
    auth:process.env.API_KEY
})
const calendarId=process.env.CALENDAR_ID
const oauth2Client = new google.auth.OAuth2(
process.env.CLIENT_ID,
process.env.CLIENT_SECRET,
process.env.REDIRECT_URL
)
const scopes = [
    'https://www.googleapis.com/auth/calendar'
  ];
  
// ---------------------------------------------------------------------------------------------------
app.get("/google",(req,res)=>{

    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes
      });
      res.redirect(url);
})
// -------------------------------------------------------------------------------------------------------
/// Creating Acess Tokens
var refreshToken = "";
var accessToken = "";

app.get("/google/redirect", async (req, res) => {
    try {
        const code = req.query.code; // Getting the authorization code
        const { tokens } = await oauth2Client.getToken(code);

        oauth2Client.setCredentials(tokens);
        refreshToken = tokens.refreshToken;
        accessToken = tokens.accessToken;

        // Redirect to the schedule-event endpoint after successful login
        res.send({msg:"Done"});
    } catch (error) {
        console.error("Error obtaining tokens:", error);
        res.status(500).send("Error obtaining tokens");
    }
});

// ----------------------------------------------------------------------------------------
//book-slot
app.post('/book-slot', async (req, res) => {
    const startTime = new Date(req.body.startTime);
    const endTime = new Date(req.body.endTime);

    try {
      
        const response = await calendar.events.list({
            calendarId: calendarId, 
            auth: oauth2Client, 
            timeMin: startTime.toISOString(), 
            timeMax: endTime.toISOString(), 
            maxResults: 2500, 
            singleEvents: true,
            orderBy: 'startTime'
        });

        const events = response.data.items;

        const isLunchtimeEvent = events.some(event => event.summary && event.summary.toLowerCase() === 'lunchtime');

        
        if (isLunchtimeEvent) {
            return res.status(400).json({ message: 'Cannot create a slot during lunchtime.' });
        }

        
        const existingSlot = await User.findOne({ startTime, endTime });
        if (existingSlot) {
            return res.status(400).json({ message: 'Slot is already booked. Choose another slot.' });
        }

       
        await User.create({ startTime, endTime, isBooked: true, accessToken: accessToken });

        // Insert the slot event into the calendar
        await calendar.events.insert({
            calendarId: calendarId,
            auth: oauth2Client,
            conferenceDataVersion: 1,
            requestBody: {
                summary: "Appointment Slot",
                description: "Available for booking",
                start: {
                    dateTime: startTime,
                    timeZone: "Asia/Kolkata",
                },
                end: {
                    dateTime: endTime,
                    timeZone: "Asia/Kolkata",
                },
                conferenceData: {
                    createRequest: {
                        requestId: uuidv4(),
                    },
                },
                attendees: [{
                    email: "chinmaymaldar2002@gmail.com",
                }]
            },
        });

        return res.status(200).json({ message: 'Slot booked successfully.' });
    } catch (error) {
        console.error('Error booking slot:', error);
        return res.status(500).json({ message: 'Internal server error.' });
    }
});

const formatTime = (date) => {
    return `${('0' + date.getHours()).slice(-2)}:${('0' + date.getMinutes()).slice(-2)}`;
};

app.get("/available-slots", async (req, res) => {
    try {
       

        // Define business hours
        const businessStartTime = new Date();
        businessStartTime.setHours(9, 0, 0, 0); 
        const businessEndTime = new Date();
        businessEndTime.setHours(17, 0, 0, 0); 

        
        const bookedSlots = await User.find({
            startTime: { $gte: businessStartTime, $lt: businessEndTime }
        })

       
        let availableSlots = [{ startTime: businessStartTime, endTime: bookedSlots[0].startTime }];

        for (let i = 1; i < bookedSlots.length; i++) {
            const prevSlot = bookedSlots[i - 1];
            const currentSlot = bookedSlots[i];
            availableSlots.push({ startTime: prevSlot.endTime, endTime: currentSlot.startTime });
        }

        
        availableSlots.push({ startTime: bookedSlots[bookedSlots.length - 1].endTime, endTime: businessEndTime });

        
        const intervals = [];
        for (let i = 0; i < availableSlots.length; i++) {
            const slot = availableSlots[i];
            const startTime = formatTime(slot.startTime);
            const endTime = formatTime(slot.endTime);
            intervals.push({ startTime, endTime });
        }

        return res.status(200).json({ availableSlots: intervals });
    } catch (error) {
        console.error('Error fetching available slots:', error);
        return res.status(500).json({ message: 'Internal server error.' });
    }
});



async function sendEmails(meetLinks, attendees) {
    try {
        // Iterate through attendees and send emails with Google Meet links
        for (let i = 0; i < attendees.length; i++) {
            const mailOptions = {
                from: "chinmay@7dliving.com",
                to: attendees[i].join(", "),
                subject: "Google Meet Link for Scheduled Event",
                text: `Here is the Google Meet link for your scheduled event: ${meetLinks[i]}`
            };

            // Send email
            await transporter.sendMail(mailOptions);
        }
    } catch (error) {
        console.error("Error sending emails:", error);
    }
}


// // ------------------------------------------------------------------------------------------------------
app.get("/get-events", async (req, res) => {
    try {
        // Fetch events from Google Calendar API
        const response = await calendar.events.list({
            calendarId:calendarId, 
            auth: oauth2Client,
            timeMin: new Date().toISOString(), // Retrieve events from now onwards
            maxResults: 10, // Maximum number of events to retrieve
            singleEvents: true,
            orderBy: "startTime"
        });

        const events = response.data.items;

        // Extract Google Meet links and attendees from events
        const meetLinks = [];
        const attendees = [];

        events.forEach(event => {
            if (event.conferenceData && event.conferenceData.entryPoints) {
                const meetLink = event.conferenceData.entryPoints.find(entry => entry.entryPointType === "video")?.uri;
                if (meetLink) {
                    meetLinks.push(meetLink);
                    attendees.push(event.attendees.map(attendee => attendee.email));
                }
            }
        });

        // Send emails with Google Meet links to attendees
        await sendEmails(meetLinks, attendees);

        res.send("Emails with Google Meet links sent successfully.");
    } catch (error) {
        console.error("Error fetching or sending events:", error);
        res.status(500).send("Error fetching or sending events");
    }
});
// ----------------------------------------------------------------------------------------------



app.listen(3001,()=>{
    console.log("server is running on 3001");
})



