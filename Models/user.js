const mongoose=require("mongoose");

const UserSchema = new mongoose.Schema({
    startTime: Date,
    endTime: Date,
    isBooked: { type: Boolean, default: false },
    accessToken: String,
    
});

const User = mongoose.model('User', UserSchema);

module.exports=User